// Real MongoDB for the tests that depend on its atomic updates and unique
// indexes (concurrent cron ticks, duplicate requests, leases).
//
// MONGODB_TEST_URI (a server, no database name) is used when set. Otherwise an
// in-memory server is started with mongodb-memory-server: it uses a local
// mongod when one is on the PATH, or downloads one the first time (CI).
// Every run gets its own database, dropped at the end.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import mongoose from 'mongoose';

function mongodOnPath() {
  const names = process.platform === 'win32' ? ['mongod.exe'] : ['mongod'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) {
      const full = path.join(dir, n);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** Start (or connect to) a test database. Returns { uri, stop }. Does not connect mongoose. */
export async function startTestDatabase() {
  const dbName = `foa_test_${process.pid}_${Date.now()}`;
  let server = null;
  let uri;
  if (process.env.MONGODB_TEST_URI) {
    uri = `${process.env.MONGODB_TEST_URI.replace(/\/+$/, '')}/${dbName}`;
  } else {
    if (!process.env.MONGOMS_SYSTEM_BINARY) {
      const local = mongodOnPath();
      if (local) process.env.MONGOMS_SYSTEM_BINARY = local;
    }
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    // Several test files start their own server at once; give a busy machine time.
    server = await MongoMemoryServer.create({ instance: { launchTimeout: 60000 } });
    uri = server.getUri(dbName);
  }
  return {
    uri,
    async stop() {
      try {
        if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
      } finally {
        await mongoose.disconnect();
        if (server) await server.stop();
      }
    },
  };
}

/** Build every model's indexes (unique, TTL) before a test relies on them. */
export async function buildIndexes() {
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
  const { ensureOutboxIndexes } = await import('../src/models/index.js');
  await ensureOutboxIndexes();
}

/** Serve an Express app on a free port. Returns { base, close }. */
export async function serve(app) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * A browser-like client with its own cookie jar. Sends the dashboard's CSRF
 * header unless { csrf: false }.
 */
export function client(base) {
  let cookie = '';
  async function call(method, url, body, { headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (csrf) h['X-FOA-Request'] = '1';
    if (cookie) h.cookie = cookie;
    let payload;
    if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${url}`, { method, headers: h, body: payload });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (pair.slice(0, i) === 'foa_session') cookie = pair.slice(i + 1) ? `foa_session=${pair.slice(i + 1)}` : '';
    }
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, data, headers: res.headers, setCookies };
  }
  return {
    call,
    get: (url, opts) => call('GET', url, undefined, opts),
    post: (url, body, opts) => call('POST', url, body ?? {}, opts),
    patch: (url, body, opts) => call('PATCH', url, body ?? {}, opts),
    put: (url, body, opts) => call('PUT', url, body ?? {}, opts),
    get cookie() {
      return cookie;
    },
    set cookie(v) {
      cookie = v;
    },
  };
}

/** Environment for a test that imports the app. Call before importing it. */
export function testEnv(uri, extra = {}) {
  Object.assign(process.env, {
    MONGODB_URI: uri,
    GROQ_API_KEY: '',
    ACCESS_PASSWORD: '',
    DEMO_MODE: 'true',
    RATE_LIMIT_MAX: '0',
    LOGIN_RATE_LIMIT_MAX: '0',
    CRON_SECRET: 'test-cron-secret-0123456789-abcdefgh',
    TIME_ZONE: 'Australia/Sydney',
    REVIEWERS: '',
    APPROVERS: '',
    PAYERS: '',
    SEGREGATE_DUTIES: 'false',
    APP_ENV: 'development',
    RESEND_API_KEY: '',
    SMTP_HOST: '',
    ALERT_EMAILS: '',
    ADMIN_SETUP_TOKEN: '',
    // The assistant: generous limits, so tests check answers, not how fast this machine is; the
    // tests of timeouts set their own. No reasoning effort unless a test asks for it.
    ORCHESTRATOR_BUDGET_SECONDS: '120',
    ORCHESTRATOR_STEP_SECONDS: '60',
    GROQ_CLASSIFY_REASONING_EFFORT: '',
    // Empty: the defaults in config.js, whatever a local server/.env says
    // (dotenv never replaces a variable that is already set, even to '').
    MATCH_THRESHOLD: '',
    MIN_CONFIDENCE: '',
    MIN_EMAIL_CONFIDENCE: '',
    PRICE_TOLERANCE_PCT: '',
    MISSING_ABN_POLICY: '',
    ...extra,
  });
}
