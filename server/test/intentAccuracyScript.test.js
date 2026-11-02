// scripts/intent-accuracy.js in --dry-run mode: no Groq call, no key needed.
// It must run against a throwaway test database and score the router on the
// fixture questions: every question it answers is correct, none is wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the accuracy script scores the router on the fixtures without calling Groq', async () => {
  const out = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(root, 'scripts/intent-accuracy.js'), '--dry-run'],
      { cwd: root, env: { ...process.env, GROQ_API_KEY: '' }, timeout: 120000 },
      (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)),
    );
  });
  assert.match(out, /Model: \(none, dry run\)/);
  assert.match(out, /Wrong without asking: 0/);
  const [, correct, scored] = out.match(/Accuracy: +(\d+)\/(\d+)/);
  assert.equal(correct, scored, 'every question the router answers is correct');
  assert.ok(Number(scored) >= 17, `the router answers ${scored} questions`);
  assert.match(out, /Router \/ model: +\d+ \/ 0/, 'no model call in a dry run');
  assert.ok(!/gsk_|Bearer/.test(out), 'no key printed');
});
