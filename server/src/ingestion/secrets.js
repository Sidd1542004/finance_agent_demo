// Encrypts the mailbox refresh tokens before they are stored in MongoDB.
//
// AES-256-GCM with a 32-byte key from INGESTION_ENCRYPTION_KEY (base64 or hex).
// Stored: { v: 1, keyId, iv, tag, data }. keyId is a short fingerprint of the
// key, so a changed key is reported clearly ("reconnect the mailbox") instead
// of failing obscurely. The key itself is never stored or logged.

import crypto from 'node:crypto';

export class SecretError extends Error {}

/** The 32-byte key, or null when it is missing or not 32 bytes. */
export function parseKey(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const candidates = [];
  if (/^[0-9a-f]{64}$/i.test(s)) candidates.push(Buffer.from(s, 'hex'));
  try {
    candidates.push(Buffer.from(s, 'base64'));
  } catch {
    /* not base64 */
  }
  return candidates.find((b) => b.length === 32) || null;
}

const keyIdOf = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);

export function createSealer(keyValue) {
  const key = parseKey(keyValue);
  return {
    available: Boolean(key),
    seal(plaintext) {
      if (!key) throw new SecretError('INGESTION_ENCRYPTION_KEY is not set to 32 bytes (base64 or hex).');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return { v: 1, keyId: keyIdOf(key), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    },
    open(sealed) {
      if (!key) throw new SecretError('INGESTION_ENCRYPTION_KEY is not set to 32 bytes (base64 or hex).');
      if (!sealed || sealed.v !== 1) throw new SecretError('No stored credentials.');
      if (sealed.keyId !== keyIdOf(key)) throw new SecretError('The stored credentials were encrypted with a different INGESTION_ENCRYPTION_KEY. Reconnect the mailbox.');
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
      } catch {
        throw new SecretError('The stored credentials could not be decrypted. Reconnect the mailbox.');
      }
    },
  };
}

/** Random URL-safe text, for OAuth state and PKCE verifiers. */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');
/** PKCE S256 challenge for a verifier. */
export const pkceChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');
