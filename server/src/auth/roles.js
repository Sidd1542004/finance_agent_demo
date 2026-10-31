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

/** Does the user hold (or imply) any of these roles? */
export const hasRole = (user, ...wanted) => {
  if (!user) return false;
  const held = effectiveRoles(user.roles);
  return wanted.some((r) => held.includes(r));
};
