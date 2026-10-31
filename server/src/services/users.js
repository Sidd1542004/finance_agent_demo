// User accounts: create, sign in, change roles, deactivate, reset passwords.
// Used by the auth and admin routes and by scripts/create-admin.js.
// Passwords are never logged, returned or written to the audit log.

import mongoose from 'mongoose';
import { User, ROLES, Setting } from '../models/index.js';
import { hashPassword, verifyPassword, dummyHash, passwordProblem } from '../auth/passwords.js';
import { publicUser, revokeUserSessions } from '../auth/sessions.js';
import { HttpError, recordAudit } from './runs.js';
import { requireActor } from './actor.js';
import { systemActor } from '../auth/roles.js';

// Who creates the first administrator: the one-time setup form, or the command line.
export const SETUP_ACTOR = systemActor({ id: 'system:first-admin-setup', name: 'First administrator setup', roles: ['admin'] });
export const COMMAND_LINE_ACTOR = systemActor({ id: 'system:command-line', name: 'Command line (create-admin)', roles: ['admin'] });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const LOGIN_FAILED = 'The email or password is incorrect.';

const cleanEmail = (email) =>
  String(email || '')
    .trim()
    .toLowerCase()
    .slice(0, 200);
const cleanName = (name) =>
  String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 120);

export function cleanRoles(roles) {
  if (!Array.isArray(roles)) throw new HttpError(400, 'Roles must be a list.');
  const unknown = roles.filter((r) => !ROLES.includes(r));
  if (unknown.length) throw new HttpError(400, `Unknown role: ${unknown.join(', ')}. Roles: ${ROLES.join(', ')}.`);
  return [...new Set(roles)];
}

const actorOf = (by) => ({ actor: by.name, actorId: by.id });

// `by`: an authenticated administrator, or SETUP_ACTOR / COMMAND_LINE_ACTOR.
export async function createUser({ email, name, password, roles = [] }, by) {
  requireActor(by, 'admin');
  const e = cleanEmail(email);
  const n = cleanName(name);
  if (!EMAIL.test(e)) throw new HttpError(400, 'Enter a valid email address.');
  if (!n) throw new HttpError(400, 'Enter the person’s name.');
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
  const r = cleanRoles(roles);
  let user;
  try {
    user = await User.create({ email: e, name: n, passwordHash: await hashPassword(password), roles: r, createdBy: by.system ? null : by.id, passwordChangedAt: new Date() });
  } catch (err) {
    if (err?.code === 11000) throw new HttpError(409, 'A user with that email already exists.');
    throw err;
  }
  await recordAudit({ subjectKind: 'user', subjectId: user._id, ...actorOf(by), action: 'user_created', to: r.join(',') || 'no roles', detail: `${n} <${e}>` });
  return publicUser(user);
}

/**
 * Check an email and password. Returns the user, or throws 401 with the same
 * message whatever was wrong. An account is locked for a while after too many
 * failures in a row.
 */
export async function authenticate(email, password, { maxFailedLogins, lockMinutes, now = new Date() }) {
  const user = await User.findOne({ email: cleanEmail(email) });
  if (!user) {
    await verifyPassword(String(password ?? ''), await dummyHash()); // same timing as a real check
    throw new HttpError(401, LOGIN_FAILED);
  }
  if (user.lockedUntil && user.lockedUntil > now) {
    throw new HttpError(429, 'Too many failed sign-ins for this account. Try again later, or ask an administrator to reset the password.');
  }
  const ok = await verifyPassword(String(password ?? ''), user.passwordHash);
  if (!ok || user.active === false) {
    if (!ok) {
      const failed = (user.failedLogins || 0) + 1;
      const lock = failed >= maxFailedLogins ? new Date(now.getTime() + lockMinutes * 60000) : null;
      await User.updateOne({ _id: user._id }, { $set: { failedLogins: lock ? 0 : failed, lockedUntil: lock } });
      if (lock) await recordAudit({ subjectKind: 'user', subjectId: user._id, actor: 'System', action: 'locked', reason: `${failed} failed sign-ins in a row.` });
    }
    throw new HttpError(401, LOGIN_FAILED);
  }
  await User.updateOne({ _id: user._id }, { $set: { failedLogins: 0, lockedUntil: null, lastLoginAt: now } });
  return publicUser(user);
}

export async function listUsers() {
  return (await User.find().sort({ name: 1 }).lean()).map((u) => ({
    ...publicUser(u),
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    locked: Boolean(u.lockedUntil && u.lockedUntil > new Date()),
  }));
}

const findUser = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'That user does not exist.');
  const user = await User.findById(id);
  if (!user) throw new HttpError(404, 'That user does not exist.');
  return user;
};

/** Change a user's name, roles or active flag. An admin cannot lock themselves out. */
export async function updateUser(id, input, by) {
  requireActor(by, 'admin');
  const user = await findUser(id);
  const set = {};
  const changes = [];
  if (input.name !== undefined) {
    const n = cleanName(input.name);
    if (!n) throw new HttpError(400, 'Enter the person’s name.');
    if (n !== user.name) {
      set.name = n;
      changes.push(`name: ${user.name} -> ${n}`);
    }
  }
  if (input.roles !== undefined) {
    const r = cleanRoles(input.roles);
    if (String(user._id) === by.id && !r.includes('admin')) throw new HttpError(409, 'You cannot remove your own administrator role.');
    if ([...r].sort().join(',') !== [...user.roles].sort().join(',')) {
      set.roles = r;
      changes.push(`roles: ${user.roles.join(',') || 'none'} -> ${r.join(',') || 'none'}`);
    }
  }
  if (input.active !== undefined) {
    const active = Boolean(input.active);
    if (String(user._id) === by.id && !active) throw new HttpError(409, 'You cannot deactivate your own account.');
    if (active !== (user.active !== false)) {
      set.active = active;
      changes.push(active ? 'reactivated' : 'deactivated');
    }
  }
  if (!changes.length) return publicUser(user);
  if (set.roles && !set.roles.includes('admin') && user.roles.includes('admin')) await assertAnotherAdmin(user._id);
  if (set.active === false && user.roles.includes('admin')) await assertAnotherAdmin(user._id);
  const updated = await User.findByIdAndUpdate(user._id, { $set: set }, { new: true }).lean();
  if (set.active === false) await revokeUserSessions(user._id);
  await recordAudit({ subjectKind: 'user', subjectId: user._id, ...actorOf(by), action: 'user_updated', detail: changes.join('; ') });
  return publicUser(updated);
}

async function assertAnotherAdmin(exceptId) {
  const others = await User.countDocuments({ _id: { $ne: exceptId }, roles: 'admin', active: { $ne: false } });
  if (!others) throw new HttpError(409, 'At least one active administrator must remain.');
}

/** An administrator sets a new password for someone. Signs them out everywhere. */
export async function resetPassword(id, password, by) {
  requireActor(by, 'admin');
  const user = await findUser(id);
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
  await User.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(password), passwordChangedAt: new Date(), failedLogins: 0, lockedUntil: null } });
  await revokeUserSessions(user._id);
  await recordAudit({ subjectKind: 'user', subjectId: user._id, ...actorOf(by), action: 'password_reset', detail: 'Password set by an administrator. Signed out everywhere.' });
}

/** A user changes their own password. Other sessions are signed out. */
export async function changeOwnPassword(user, current, next) {
  requireActor(user);
  const doc = await findUser(user.id);
  if (!(await verifyPassword(String(current ?? ''), doc.passwordHash))) throw new HttpError(400, 'The current password is incorrect.');
  const problem = passwordProblem(next);
  if (problem) throw new HttpError(400, problem);
  await User.updateOne({ _id: doc._id }, { $set: { passwordHash: await hashPassword(next), passwordChangedAt: new Date() } });
  await revokeUserSessions(doc._id, user.sessionId);
  await recordAudit({ subjectKind: 'user', subjectId: doc._id, actor: user.name, actorId: user.id, action: 'password_changed' });
}

export const userCount = () => User.estimatedDocumentCount();

/**
 * The first administrator, only while no user exists. A marker document with a
 * fixed _id is inserted first, so two setup requests at once cannot both win.
 */
export async function createFirstAdmin(input) {
  if ((await User.countDocuments()) > 0) throw new HttpError(409, 'Setup is already done. Sign in instead.');
  try {
    await Setting.create({ _id: 'first_admin', value: { at: new Date().toISOString() } });
  } catch (err) {
    if (err?.code === 11000) throw new HttpError(409, 'Setup is already done. Sign in instead.');
    throw err;
  }
  try {
    return await createUser({ ...input, roles: ['admin'] }, SETUP_ACTOR);
  } catch (err) {
    await Setting.deleteOne({ _id: 'first_admin' });
    throw err;
  }
}
