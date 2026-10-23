// Password hashing with Node's built-in scrypt (memory-hard, salted), so no
// native dependency is needed on Vercel. Stored as
//   scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
// so the cost can be raised later without breaking older hashes.

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

const COST = { N: 32768, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MAX_MEMORY = 128 * 1024 * 1024;

export const PASSWORD_RULE = 'Use at least 12 characters.';

function derive(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    scrypt(String(password).normalize('NFKC'), salt, KEY_LENGTH, { N, r, p, maxmem: MAX_MEMORY }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Why a new password is not acceptable, or null. */
export function passwordProblem(password) {
  const s = String(password ?? '');
  if (s.length < 12) return `The password is too short. ${PASSWORD_RULE}`;
  if (s.length > 200) return 'The password is too long (at most 200 characters).';
  return null;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** True when `password` matches the stored hash. Never throws on a malformed hash. */
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  try {
    const key = await derive(password ?? '', Buffer.from(saltB64, 'base64'), { N: Number(N), r: Number(r), p: Number(p) });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// A hash of a random password, compared against when the email is unknown,
// so a login attempt takes the same time whether or not the account exists.
let dummy = null;
export async function dummyHash() {
  if (!dummy) dummy = await hashPassword(randomBytes(24).toString('base64'));
  return dummy;
}
