// Who may do what: the one place that says which roles a stored role grants.
//
// An administrator can work in every module, so `admin` also grants the
// reviewer, approver and payer roles. This is a role check, not a bypass: every
// other control still applies to administrators (segregation of duties, the
// two-person rule for bank details, status checks, payment idempotency, notes
// and the audit log). The client mirrors this in client/src/format.js.

export const IMPLIED_ROLES = Object.freeze({ admin: Object.freeze(['reviewer', 'approver', 'payer']) });

/** The roles a person effectively holds: their own plus any they imply. Unknown values grant nothing extra. */
export function effectiveRoles(roles) {
  const out = new Set();
  for (const r of Array.isArray(roles) ? roles : []) {
    if (typeof r !== 'string') continue;
    out.add(r);
    if (Object.hasOwn(IMPLIED_ROLES, r)) for (const implied of IMPLIED_ROLES[r]) out.add(implied);
  }
  return [...out];
}

/** Does the user hold (or imply) any of these roles? No user, no roles or no wanted role: false. */
export const hasRole = (user, ...wanted) => {
  if (!user) return false;
  const held = effectiveRoles(user.roles);
  return wanted.some((r) => held.includes(r));
};

// ----- Who is acting -----
//
// Every decision (approve, pay, change bank details, ...) needs an
// AUTHENTICATED actor: an object this server built itself, either from a
// signed-in session (middleware.js loadUser and actorOf) or as a named system
// actor in code (the demo loader, the command-line admin script, first-admin
// setup). The set below holds those objects by identity, so an object built
// from data - a request body, a typed name, JSON from an AI model - is never
// an actor, whatever fields it has. There is no fallback to a typed name.

const TRUSTED = new WeakSet();

/** Mark an actor built by this server (from a session, or in code). Never call it on request data. */
export function trustActor(actor) {
  if (!actor || typeof actor !== 'object') throw new Error('An actor must be an object.');
  TRUSTED.add(actor);
  return actor;
}

export const isTrustedActor = (actor) => Boolean(actor) && typeof actor === 'object' && TRUSTED.has(actor);

/** A named actor for work the system does in code, not on a person's request. Frozen. */
export function systemActor({ id, name, roles = [] }) {
  return trustActor(Object.freeze({ id: String(id), name: String(name), roles: Object.freeze([...roles]), system: true }));
}

/**
 * Why this actor may not act, as { status, message }, or null. 401 when it is
 * not an authenticated actor; 403 when it lacks every one of `roles` (none
 * given: any authenticated actor). Denied by default.
 */
export function actorProblem(actor, ...roles) {
  if (!isTrustedActor(actor) || !String(actor.id ?? '').trim() || !String(actor.name ?? '').trim()) return { status: 401, message: 'Sign in to continue.' };
  if (roles.length && !hasRole(actor, ...roles)) return { status: 403, message: `This needs the ${roles.join(' or ')} role.` };
  return null;
}
