// Boot the real Express app on a fresh test database, with one user per role.
//
//   const t = await startApp({ SIM_BANK_DELAY_SECONDS: '0' });
//   const payer = await t.signIn('payer');
//   ...
//   test.after(t.stop);

import assert from 'node:assert/strict';
import { startTestDatabase, serve, client, testEnv, buildIndexes } from './mongo.js';

export const PASSWORD = 'a long test password';

export const PEOPLE = {
  reviewer: { email: 'rev@test.example', name: 'Rita Reviewer', roles: ['reviewer'] },
  approver: { email: 'app@test.example', name: 'Priya Approver', roles: ['approver'] },
  approver2: { email: 'app2@test.example', name: 'Omar Approver', roles: ['approver'] },
  payer: { email: 'pay@test.example', name: 'Sam Payer', roles: ['payer'] },
  payer2: { email: 'pay2@test.example', name: 'Pat Payer', roles: ['payer'] },
  admin: { email: 'admin@test.example', name: 'Ada Admin', roles: ['admin'] },
  approverPayer: { email: 'both@test.example', name: 'Alex Both', roles: ['approver', 'payer'] },
};

export async function startApp(env = {}) {
  const db = await startTestDatabase();
  testEnv(db.uri, env);
  const appModule = await import('../src/app.js');
  await appModule.ensureDatabase();
  await buildIndexes();
  const { createUser } = await import('../src/services/users.js');
  const users = {};
  for (const [key, p] of Object.entries(PEOPLE)) users[key] = await createUser({ ...p, password: PASSWORD });
  const server = await serve(appModule.app);

  async function signIn(key) {
    const c = client(server.base);
    const res = await c.post('/api/auth/login', { email: PEOPLE[key].email, password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    c.user = users[key];
    return c;
  }

  return {
    base: server.base,
    users,
    signIn,
    client: () => client(server.base),
    async stop() {
      await server.close();
      await db.stop();
    },
  };
}
