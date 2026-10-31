// A CRON_SECRET shorter than 32 characters: every scheduler route is refused
// (503) with a message saying how to make a proper one, even with that secret.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../test-support/app.js';

const SHORT = 'only-twenty-chars-xx';
const t = await startApp({ CRON_SECRET: SHORT });
test.after(t.stop);

test('a short CRON_SECRET turns every scheduler route off (503), whatever is sent', async () => {
  const anon = t.client();
  for (const [method, url] of [
    ['GET', '/api/cron/daily-summary?preview=1'],
    ['GET', '/api/cron/tick'],
    ['POST', '/api/cron/ingest'],
    ['GET', '/api/cron/anything'],
  ]) {
    for (const headers of [{}, { Authorization: `Bearer ${SHORT}` }]) {
      const res = await anon.call(method, url, method === 'POST' ? {} : undefined, { csrf: false, headers });
      assert.equal(res.status, 503, `${method} ${url}`);
      assert.match(res.data.error, /CRON_SECRET is too short: use at least 32/);
    }
  }
});
