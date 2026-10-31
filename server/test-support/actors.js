// Actors for tests: what the server builds from a signed-in session
// (auth/middleware.js actorOf). A plain object is not an actor (auth/roles.js),
// so in-memory tests use these.

import { trustActor, systemActor } from '../src/auth/roles.js';

export const ALL_WORKING_ROLES = ['reviewer', 'approver', 'payer'];

const people = new Map();

/** A signed-in person; the same name and roles give the same actor (and account id). */
export function person(name, roles = ALL_WORKING_ROLES) {
  const key = `${name}|${[...roles].sort().join(',')}`;
  if (!people.has(key)) {
    const id = `u-${String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')}`;
    people.set(key, trustActor({ id, name, roles: [...roles], sessionId: `test-session-${id}` }));
  }
  return people.get(key);
}

/** The actor that creates the test accounts. */
export const TEST_SETUP = systemActor({ id: 'system:test-setup', name: 'Test setup', roles: ['admin'] });
