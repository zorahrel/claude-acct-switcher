// The shell scripts must be checked out with LF endings, on every platform.
//
// This is not a style rule. Git for Windows defaults to core.autocrlf=true, so
// a plain clone there rewrites `vdm` with CRLF, and a shebang line ending in CR
// makes the kernel look for an interpreter called "bash\r". The error names a
// file that plainly exists, which is why it costs so much time to diagnose.
//
// .gitattributes is what prevents it. This test is what notices if that file is
// ever dropped or narrowed — a check that costs a millisecond and replaces an
// hour of confusion on someone else's machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Everything an interpreter reads. install.ps1 is deliberately absent: it is
// read by PowerShell, which does not care, and .gitattributes gives it CRLF so
// that Notepad renders it as more than one line.
const MUST_BE_LF = ['vdm', 'install.sh', 'uninstall.sh', 'install-hooks.sh'];

for (const file of MUST_BE_LF) {
  test(`${file} has no CR bytes`, () => {
    const raw = readFileSync(join(root, file));
    const cr = raw.indexOf(0x0d);
    assert.equal(cr, -1,
      `${file} contains a CR at byte ${cr}. A shebang ending in CR makes execve ` +
      `look for "bash\\r" and report that a file which exists cannot be found.`);
  });
}

test('.gitattributes pins line endings so a Windows clone cannot rewrite them', () => {
  const attrs = readFileSync(join(root, '.gitattributes'), 'utf8');
  assert.match(attrs, /^\*\s+text=auto\s+eol=lf$/m,
    '.gitattributes must force LF for all text files, or Git for Windows will ' +
    'convert the shell scripts on checkout and nothing here will run.');
});

test('the JS sources are LF too, so source-slicing tests keep matching', () => {
  // Several tests lift functions out of dashboard.mjs by slicing on "\n}\n".
  // They now normalise on read, but the checked-in files should not need it.
  for (const f of readdirSync(root).filter(f => f.endsWith('.mjs'))) {
    const raw = readFileSync(join(root, f));
    assert.equal(raw.indexOf(0x0d), -1, `${f} contains CR bytes`);
  }
});
