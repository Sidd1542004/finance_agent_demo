// Deployment: one Express app for local and Vercel, a database connection that
// is shared and retried, and no credentials in any output.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { safeUri, redactSecrets } from '../src/safeUri.js';
import { createDatabaseGate } from '../src/app.js';
import { restorePath } from '../../api/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('safeUri keeps protocol, host and path only', () => {
  assert.equal(safeUri('mongodb+srv://finance:p%40ss@cluster0.abc.mongodb.net/finance_agent?retryWrites=true&w=majority'), 'mongodb+srv://cluster0.abc.mongodb.net/finance_agent');
  assert.equal(safeUri('mongodb://127.0.0.1:27017/finance_agent'), 'mongodb://127.0.0.1:27017/finance_agent');
  assert.equal(safeUri('mongodb://user@h1:1,h2:2/db'), 'mongodb://h1:1,h2:2/db');
  assert.equal(safeUri(''), '(not a valid connection string)');
  assert.equal(safeUri('not a uri with secret'), '(not a valid connection string)');
});

test('redactSecrets removes credentials from URLs and the password from any text', () => {
  const uri =
  'mongodb+srv://test-user:dummy-password@example.invalid/db';
  assert.equal(redactSecrets('failed for mongodb+srv://finance:Hunter2%21x@cluster0.abc.mongodb.net/db', uri), 'failed for mongodb+srv://***@cluster0.abc.mongodb.net/db');
  assert.equal(redactSecrets('bad auth: password Hunter2!x rejected', uri), 'bad auth: password *** rejected');
  assert.equal(redactSecrets('nothing to hide', uri), 'nothing to hide');
});

test('the database gate shares one attempt, does not cache a failure, and seeds once', async () => {
  let connected = false;
  let connects = 0;
  let seeds = 0;
  let fail = true;
  const ensure = createDatabaseGate({
    isConnected: () => connected,
    connect: async () => {
      connects += 1;
      await new Promise((r) => setTimeout(r, 5));
      if (fail) throw new Error('unreachable');
      connected = true;
    },
    seed: async () => {
      seeds += 1;
      return false;
    },
  });

  const results = await Promise.allSettled([ensure(), ensure(), ensure()]);
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.equal(connects, 1, 'concurrent callers share one attempt');

  fail = false;
  await Promise.all([ensure(), ensure()]);
  assert.equal(connects, 2, 'the failure was not cached: the next request tried again');
  await ensure();
  assert.equal(connects, 2, 'the open connection is reused');
  assert.equal(seeds, 1);

  connected = false; // a dropped connection is opened again, without seeding again
  await ensure();
  assert.equal(connects, 3);
  assert.equal(seeds, 1);
});

test('the Vercel handler restores the original API path and keeps the query', () => {
  assert.equal(restorePath('/api?__path=invoices'), '/api/invoices');
  assert.equal(restorePath('/api?__path=invoices%2Fabc%2Factions%2Fapprove'), '/api/invoices/abc/actions/approve');
  assert.equal(
    restorePath('/api?__path=invoices/abc/actions/approve&before=2026-10-01T00%3A00%3A00.000Z&limit=5'),
    '/api/invoices/abc/actions/approve?before=2026-10-01T00%3A00%3A00.000Z&limit=5',
  );
  assert.equal(restorePath('/api?limit=5&__path=reports'), '/api/reports?limit=5');
  assert.equal(restorePath('/api/health'), '/api/health', 'a request that was not rewritten is left alone');
});

test('a wrong MONGODB_URI gives a 503 with a clear message, and the password never appears', async () => {
  const secret = 'Sup3rSecretPw9';
  // Run in an empty folder so no .env file is loaded.
  const cwd = mkdtempSync(path.join(tmpdir(), 'fa-deploy-'));
  const script = `
    const { default: handler } = await import(${JSON.stringify(
      path
        .join(here, '../../api/index.js')
        .replace(/\\/g, '/')
        .replace(/^([A-Z]):/, 'file:///$1:'),
    )});
    const http = await import('node:http');
    const server = http.createServer(handler).listen(0, async () => {
      const res = await fetch('http://127.0.0.1:' + server.address().port + '/api?__path=health');
      console.log('STATUS ' + res.status + ' ' + JSON.stringify(await res.json()));
      server.close();
      process.exit(0);
    });`;
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd,
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, MONGODB_URI: `mongodb://finance:${secret}@bad host name:27017/finance_agent` },
      });
      let text = '';
      child.stdout.on('data', (d) => (text += d));
      child.stderr.on('data', (d) => (text += d));
      child.on('error', reject);
      child.on('close', () => resolve(text));
    });
    assert.match(out, /STATUS 503 /);
    assert.match(out, /The database cannot be reached\. Check MONGODB_URI, and that MongoDB Atlas Network Access allows this server \(0\.0\.0\.0\/0 for Vercel\)\./);
    assert.ok(!out.includes(secret), 'the password is not in any output');
    assert.ok(!out.includes('finance:'), 'nor the user name with it');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
