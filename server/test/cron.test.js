// The scheduler endpoints (/api/cron/*): one CRON_SECRET guard in front of
// every path, including ones that do not exist; the secret only in the
// Authorization header; never cached; repeated failures slowed down; and the
// schedules in vercel.json and the GitHub Actions backup.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp } from '../test-support/app.js';

const FAILURE_LIMIT = 40;
const t = await startApp({ CRON_FAILURE_LIMIT: String(FAILURE_LIMIT), CRON_FAILURE_WINDOW_MINUTES: '15' });
test.after(t.stop);

const { cronProblem, MIN_CRON_SECRET_LENGTH } = await import('../src/routes/cron.js');
const SECRET = process.env.CRON_SECRET;
const BEARER = { headers: { Authorization: `Bearer ${SECRET}` } };
const ROUTES = [
  ['GET', '/api/cron/daily-summary?preview=1'],
  ['GET', '/api/cron/tick'],
  ['POST', '/api/cron/tick'],
  ['GET', '/api/cron/ingest'],
  ['POST', '/api/cron/ingest'],
];
const call = (c, [method, url], opts = {}) => c.call(method, url, method === 'POST' ? {} : undefined, { csrf: false, ...opts });
let failures = 0;
const refusedCall = async (...args) => {
  failures += 1;
  return call(...args);
};

test('the guard: unset or short secrets refuse everything (503); a wrong or missing one is 401', () => {
  const ok = 'x'.repeat(MIN_CRON_SECRET_LENGTH);
  assert.equal(MIN_CRON_SECRET_LENGTH, 32);
  assert.equal(cronProblem({ secret: '', authorization: 'Bearer ' }).status, 503);
  assert.match(cronProblem({ secret: 'short-secret', authorization: 'Bearer short-secret' }).error, /too short/);
  assert.equal(cronProblem({ secret: ok, authorization: undefined }).status, 401);
  assert.equal(cronProblem({ secret: ok, authorization: `Bearer ${ok}x` }).status, 401);
  assert.equal(cronProblem({ secret: ok, authorization: `Basic ${Buffer.from(`x:${ok}`).toString('base64')}` }).status, 401);
  assert.equal(cronProblem({ secret: ok, authorization: `Bearer ${ok}` }), null);
  assert.equal(cronProblem({ secret: ok, authorization: `bearer   ${ok}` }), null, 'the scheme is case-insensitive');
});

test('every scheduler route needs Authorization: Bearer CRON_SECRET; a session, Basic auth or the URL is not enough', async () => {
  const anon = t.client();
  const admin = await t.signIn('admin');
  for (const route of ROUTES) {
    const label = route.join(' ');
    assert.equal((await refusedCall(anon, route)).status, 401, `${label}: no header`);
    assert.equal((await refusedCall(anon, route, { headers: { Authorization: 'Bearer wrong' } })).status, 401, `${label}: wrong`);
    assert.equal((await refusedCall(anon, route, { headers: { Authorization: SECRET } })).status, 401, `${label}: no Bearer`);
    const inUrl = [route[0], `${route[1]}${route[1].includes('?') ? '&' : '?'}secret=${SECRET}&CRON_SECRET=${SECRET}`];
    assert.equal((await refusedCall(anon, inUrl)).status, 401, `${label}: the secret in the URL is never read`);
    assert.equal((await refusedCall(admin, route)).status, 401, `${label}: an administrator's session is not the scheduler`);
    const ok = await call(anon, route, BEARER);
    assert.equal(ok.status, 200, `${label}: ${JSON.stringify(ok.data)}`);
    assert.equal(ok.headers.get('cache-control'), 'no-store', label);
  }
});

test('a path under /api/cron that does not exist is behind the same guard: 401 without the secret, 404 with it', async () => {
  const anon = t.client();
  const refused = await refusedCall(anon, ['GET', '/api/cron/something-new']);
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get('cache-control'), 'no-store');
  assert.equal((await refusedCall(anon, ['POST', '/api/cron/something-new'])).status, 401);
  // A 404 counts as a refused request too (only answers under 400 are not counted).
  assert.equal((await refusedCall(anon, ['GET', '/api/cron/something-new'], BEARER)).status, 404);
});

test('the schedules: Vercel Cron calls all three once a day; the GitHub Actions backup calls the tick and ingestion every 5 minutes', () => {
  const vercel = JSON.parse(fs.readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(vercel.crons.map((c) => c.path).sort(), ['/api/cron/daily-summary', '/api/cron/ingest', '/api/cron/tick']);
  for (const c of vercel.crons) assert.match(c.schedule, /^\d+ \d+ \* \* \*$/, `${c.path}: once a day (Hobby)`);
  const workflow = fs.readFileSync(new URL('../../.github/workflows/payment-tick.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '\*\/5 \* \* \* \*'/);
  assert.match(workflow, /secrets\.PAYMENT_TICK_URL/);
  assert.match(workflow, /secrets\.INGEST_URL/);
  assert.match(workflow, /Authorization: Bearer \$CRON_SECRET/);
  assert.doesNotMatch(workflow, /\?secret=|CRON_SECRET=\$/, 'never in a URL');
});

// Last: it uses up this address's allowance of refused requests.
test('repeated refused requests from one address are slowed down (429), correct ones never count', async () => {
  const anon = t.client();
  for (let i = 0; i < 5; i += 1) assert.equal((await call(anon, ROUTES[1], BEARER)).status, 200, 'successes do not count');
  let res;
  while (failures < FAILURE_LIMIT) res = await refusedCall(anon, ROUTES[1], { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(res.status, 401, 'the last allowed refusal is still a 401');
  const blocked = await call(anon, ROUTES[1], { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /Too many refused scheduler requests/);
  assert.equal((await call(anon, ROUTES[1], BEARER)).status, 429, 'blocked for the window, even with the right secret');
});
