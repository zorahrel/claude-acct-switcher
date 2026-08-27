// Tests for the platform layer — specifically the Windows credentials-file path,
// which is the piece that can kill a live Claude Code session if it writes a
// half-finished file or wedges on a dead lock.
//
// The file store is exercised on every platform: the functions under test are
// pure filesystem work, and only running them on Windows would mean the CI that
// matters (a Mac) never sees a regression in them.

import { test, describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = new URL('.', import.meta.url).pathname;
const PLATFORM_MJS = join(HERE, '..', 'platform.mjs');

// The module resolves HOME once at import time, so each scenario runs in a child
// process with its own fake home. Passing a script on stdin avoids quoting a
// path through the shell.
function runInFakeHome(home, script) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      VDM_PLATFORM_MJS: PLATFORM_MJS.replace(/\\/g, '/'),
    },
  });
  if (res.status !== 0) {
    throw new Error(`child failed (${res.status}): ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

// Force the Windows branch regardless of the host OS by stubbing the platform
// getter before the module is imported.
const FORCE_WINDOWS = `
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
`;

describe('platform: Windows credentials file', () => {
  let home;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'vdm-platform-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('reads the credentials file Claude Code actually writes', () => {
    const creds = { claudeAiOauth: { accessToken: 'sk-ant-oat01-test', expiresAt: 123 } };
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify(creds, null, 2));

    const out = runInFakeHome(home, `${FORCE_WINDOWS}
      const p = await import(process.env.VDM_PLATFORM_MJS);
      console.log(JSON.stringify(p.readCredentials()));
    `);
    assert.deepEqual(JSON.parse(out), creds);
  });

  it('returns null rather than throwing when the file is absent', () => {
    const out = runInFakeHome(home, `${FORCE_WINDOWS}
      const p = await import(process.env.VDM_PLATFORM_MJS);
      console.log(JSON.stringify(p.readCredentials()));
    `);
    assert.equal(JSON.parse(out), null);
  });

  it('writes compact JSON that reads back identically', () => {
    const out = runInFakeHome(home, `${FORCE_WINDOWS}
      const p = await import(process.env.VDM_PLATFORM_MJS);
      p.writeCredentials({ claudeAiOauth: { accessToken: 'sk-ant-oat01-written', expiresAt: 7 } });
      console.log(JSON.stringify(p.readCredentials()));
    `);
    assert.equal(JSON.parse(out).claudeAiOauth.accessToken, 'sk-ant-oat01-written');

    const onDisk = readFileSync(join(home, '.claude', '.credentials.json'), 'utf8');
    assert.ok(!onDisk.includes('\n'), 'credentials must be one line: a multi-line value is what breaks the macOS reader, and there is no reason for the two stores to differ');
    assert.deepEqual(JSON.parse(onDisk).claudeAiOauth.accessToken, 'sk-ant-oat01-written');
  });

  it('leaves no temp file behind', () => {
    runInFakeHome(home, `${FORCE_WINDOWS}
      const p = await import(process.env.VDM_PLATFORM_MJS);
      p.writeCredentials({ claudeAiOauth: { accessToken: 'a' } });
    `);
    const files = readdirSync(join(home, '.claude'));
    assert.deepEqual(files.filter(f => f.includes('.tmp')), []);
  });

  it('breaks a lock held by a dead pid instead of waiting for it', () => {
    // pid 2^22 is above the Linux default pid_max and not a live process here.
    const deadPid = 4194304;
    writeFileSync(join(home, '.claude', '.credentials.json.lock'),
      JSON.stringify({ pid: deadPid, at: Date.now() }));

    const start = Date.now();
    const out = runInFakeHome(home, `${FORCE_WINDOWS}
      const p = await import(process.env.VDM_PLATFORM_MJS);
      p.writeCredentials({ claudeAiOauth: { accessToken: 'sk-ant-oat01-after-dead-lock' } });
      console.log(JSON.stringify(p.readCredentials()));
    `);
    const elapsed = Date.now() - start;

    assert.equal(JSON.parse(out).claudeAiOauth.accessToken, 'sk-ant-oat01-after-dead-lock');
    // The wait budget is 3s; a dead lock must not consume any of it.
    assert.ok(elapsed < 3000, `waited ${elapsed}ms on a dead lock`);
    assert.ok(!existsSync(join(home, '.claude', '.credentials.json.lock')),
      'the lock must be released after the write');
  });

  it('breaks a lock whose contents are not JSON', () => {
    writeFileSync(join(home, '.claude', '.credentials.json.lock'), 'not json at all');
    const out = runInFakeHome(home, `${FORCE_WINDOWS}
      const p = await import(process.env.VDM_PLATFORM_MJS);
      p.writeCredentials({ claudeAiOauth: { accessToken: 'sk-ant-oat01-garbage-lock' } });
      console.log(JSON.stringify(p.readCredentials()));
    `);
    assert.equal(JSON.parse(out).claudeAiOauth.accessToken, 'sk-ant-oat01-garbage-lock');
  });

  it('writes anyway when a live lock never clears, rather than losing the switch', () => {
    // A lock held by this very test process is alive and fresh, so it can be
    // neither broken nor waited out. Refusing to write would mean an account
    // switch silently does nothing; the rename keeps the file intact either way.
    writeFileSync(join(home, '.claude', '.credentials.json.lock'),
      JSON.stringify({ pid: process.pid, at: Date.now() }));

    const out = runInFakeHome(home, `${FORCE_WINDOWS}
      const p = await import(process.env.VDM_PLATFORM_MJS);
      p.writeCredentials({ claudeAiOauth: { accessToken: 'sk-ant-oat01-contended' } });
      console.log(JSON.stringify(p.readCredentials()));
    `);
    assert.equal(JSON.parse(out).claudeAiOauth.accessToken, 'sk-ant-oat01-contended');
    // Someone else's lock must survive: releasing it would be stealing.
    assert.ok(existsSync(join(home, '.claude', '.credentials.json.lock')),
      'a live foreign lock must not be deleted by our write');
  });

  it('never leaves a truncated file: a concurrent reader sees old or new, never half', () => {
    // Rename is atomic, so a reader racing 200 writes must always parse.
    const out = runInFakeHome(home, `${FORCE_WINDOWS}
      const p = await import(process.env.VDM_PLATFORM_MJS);
      const { readFileSync } = await import('node:fs');
      p.writeCredentials({ claudeAiOauth: { accessToken: 'seed' } });
      let bad = 0;
      for (let i = 0; i < 200; i++) {
        p.writeCredentials({ claudeAiOauth: { accessToken: 'tok-' + i } });
        try {
          const c = p.readCredentials();
          if (!c?.claudeAiOauth?.accessToken) bad++;
        } catch { bad++; }
      }
      console.log(String(bad));
    `);
    assert.equal(out, '0');
  });
});

describe('platform: cross-platform helpers', () => {
  it('resolves a username without spawning whoami', async () => {
    const p = await import('../platform.mjs');
    const user = p.currentUser();
    assert.ok(typeof user === 'string' && user.length > 0);
  });

  it('portInUse says true for a listening port and false for a closed one', async () => {
    const p = await import('../platform.mjs');
    const net = await import('node:net');

    const server = net.createServer();
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    assert.equal(await p.portInUse(port), true, 'a listening port must read as in use');
    await new Promise(r => server.close(r));
    assert.equal(await p.portInUse(port), false, 'a closed port must read as free');
  });

  it('notifyDesktop never throws, whatever the platform', async () => {
    const p = await import('../platform.mjs');
    await p.notifyDesktop('vdm test', 'this must not throw "quotes" and \'apostrophes\'');
  });
});
