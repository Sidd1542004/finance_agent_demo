// Protecting the demo: the optional shared password, the rate limits on work
// that calls Groq or processes files, and demo mode only when asked for.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

import { passwordMatches, basicPassword, accessAllowed, requireAccessPassword } from '../src/accessAuth.js';
import { createWorkLimiter } from '../src/rateLimit.js';
import vercelMiddleware from '../../middleware.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

async function serve(app, fn) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('the shared password: any user name, the right password, compared safely', () => {
  assert.equal(passwordMatches('open sesame', 'open sesame'), true);
  assert.equal(passwordMatches('open sesam', 'open sesame'), false);
  assert.equal(passwordMatches('', 'open sesame'), false);
  assert.equal(basicPassword(basic('anyone', 'pa:ss')), 'pa:ss', 'a colon in the password is kept');
  assert.equal(basicPassword('Bearer abc'), null);
  assert.equal(basicPassword(undefined), null);

  assert.equal(accessAllowed({ password: '', path: '/', authorization: undefined }), true, 'no password set: open');
  assert.equal(accessAllowed({ password: 'pw', path: '/', authorization: undefined }), false);
  assert.equal(accessAllowed({ password: 'pw', path: '/api/invoices', authorization: basic('x', 'pw') }), true);
  assert.equal(accessAllowed({ password: 'pw', path: '/assets/index.js', authorization: basic('someone else', 'pw') }), true);
  assert.equal(accessAllowed({ password: 'pw', path: '/api/invoices', authorization: basic('x', 'wrong') }), false);
  assert.equal(accessAllowed({ password: 'pw', path: '/api/cron/daily-summary', authorization: 'Bearer cron-secret' }), true, 'the cron route has its own secret');
});

test('Express asks for the password on pages and the API', async () => {
  const app = express();
  app.use(requireAccessPassword('pw'));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('*', (req, res) => res.type('html').send('<div id="root"></div>'));
  await serve(app, async (base) => {
    for (const p of ['/', '/api/health']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 401);
      assert.match(res.headers.get('www-authenticate'), /^Basic realm="Finance Operations Agent"/);
    }
    assert.equal((await fetch(`${base}/api/health`, { headers: { Authorization: basic('x', 'nope') } })).status, 401);
    assert.equal((await fetch(`${base}/`, { headers: { Authorization: basic('any', 'pw') } })).status, 200);
    assert.equal((await fetch(`${base}/api/health`, { headers: { Authorization: basic('', 'pw') } })).status, 200);
  });
});

test('the Vercel middleware protects the static dashboard too', async () => {
  const before = process.env.ACCESS_PASSWORD;
  try {
    delete process.env.ACCESS_PASSWORD;
    assert.equal(vercelMiddleware(new Request('https://x.vercel.app/')), undefined, 'no password: the request continues');

    process.env.ACCESS_PASSWORD = 'pw';
    const denied = vercelMiddleware(new Request('https://x.vercel.app/assets/index.js'));
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate'), /^Basic /);
    assert.equal(vercelMiddleware(new Request('https://x.vercel.app/', { headers: { Authorization: basic('me', 'pw') } })), undefined);
    assert.equal(vercelMiddleware(new Request('https://x.vercel.app/api/cron/daily-summary')), undefined);
  } finally {
    if (before === undefined) delete process.env.ACCESS_PASSWORD;
    else process.env.ACCESS_PASSWORD = before;
  }
});

test('work that calls Groq or processes files is rate limited; the limit is configurable and can be turned off', async () => {
  const app = express();
  app.post('/api/invoices', createWorkLimiter({ windowMinutes: 10, max: 2 }), (req, res) => res.status(201).json({ ok: true }));
  app.post('/api/free', createWorkLimiter({ windowMinutes: 10, max: 0 }), (req, res) => res.json({ ok: true }));
  await serve(app, async (base) => {
    assert.equal((await fetch(`${base}/api/invoices`, { method: 'POST' })).status, 201);
    assert.equal((await fetch(`${base}/api/invoices`, { method: 'POST' })).status, 201);
    const limited = await fetch(`${base}/api/invoices`, { method: 'POST' });
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /limit is 2 every 10 minutes/);
    for (let i = 0; i < 5; i += 1) assert.equal((await fetch(`${base}/api/free`, { method: 'POST' })).status, 200);
  });
});

test('demo mode (Load demo month, Reset) is on only when DEMO_MODE=true', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'fa-demo-')); // no .env here
  const configUrl = pathToFileURL(path.join(here, '../src/config.js')).href;
  const demoMode = (value) => {
    const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT };
    if (value !== undefined) env.DEMO_MODE = value;
    return execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `const { config } = await import(${JSON.stringify(configUrl)}); process.stdout.write(String(config.demoMode));`],
      { cwd, env },
    ).toString();
  };
  try {
    assert.equal(demoMode(undefined), 'false');
    assert.equal(demoMode('false'), 'false');
    assert.equal(demoMode('yes'), 'false');
    assert.equal(demoMode('true'), 'true');
    assert.equal(demoMode('TRUE'), 'true');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
