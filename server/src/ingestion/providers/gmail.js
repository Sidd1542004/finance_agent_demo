// Gmail (Gmail API, OAuth 2.0 with PKCE). Read-only: the only scope is
// gmail.readonly, which covers listing messages, reading their headers and
// downloading attachments. Nothing is sent, moved, labelled or deleted.

import { call, form, ProviderError } from '../http.js';
import { addressOf } from '../attachments.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const header = (headers, name) => (headers || []).find((h) => String(h.name).toLowerCase() === name)?.value || '';

// Every part of the message that is a file (it has a file name or an attachment id).
function fileParts(part, out = []) {
  if (!part) return out;
  const disposition = header(part.headers, 'content-disposition').toLowerCase();
  if (part.filename || part.body?.attachmentId) {
    out.push({
      key: String(part.partId ?? ''),
      attachmentId: part.body?.attachmentId || null,
      filename: part.filename || '',
      mimeType: String(part.mimeType || '').toLowerCase(),
      size: Number(part.body?.size) || 0,
      // Inline: shown in the body (logos, signatures), not attached for the reader.
      inline: disposition.startsWith('inline') || (!disposition.startsWith('attachment') && Boolean(header(part.headers, 'content-id'))),
    });
  }
  for (const p of part.parts || []) fileParts(p, out);
  return out;
}

export function createGmail({ clientId, clientSecret, label = 'INBOX', query = 'has:attachment' }, fetchImpl = fetch) {
  const opts = { label: 'Gmail' };
  let labelId = null;

  async function resolveLabel(token) {
    if (labelId) return labelId;
    if (/^[A-Z_]+$/.test(label) || /^Label_/.test(label)) return (labelId = label); // system label (INBOX) or an id
    const { labels = [] } = await call(fetchImpl, `${API}/labels`, { ...opts, headers: { Authorization: `Bearer ${token}` } });
    const found = labels.find((l) => l.name.toLowerCase() === label.toLowerCase());
    if (!found) throw new ProviderError(`Gmail has no label called "${label}". Create it, or change GMAIL_LABEL.`, { code: 'label_missing' });
    return (labelId = found.id);
  }

  return {
    name: 'gmail',
    label: 'Gmail',
    scopes: GMAIL_SCOPES,
    configured: Boolean(clientId && clientSecret),
    where: `label "${label}"${query ? `, search "${query}"` : ''}`,

    authUrl({ state, challenge, redirectUri }) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GMAIL_SCOPES.join(' '),
        access_type: 'offline', // a refresh token, so polling works without the person
        prompt: 'consent',
        include_granted_scopes: 'false',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return `${AUTH_URL}?${q}`;
    },

    async exchangeCode({ code, verifier, redirectUri }) {
      const t = await call(fetchImpl, TOKEN_URL, {
        ...opts,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
        retries: 0,
      });
      if (!t.refresh_token)
        throw new ProviderError('Google did not return a refresh token. Remove the app from your Google account permissions and connect again.', { code: 'no_refresh_token' });
      const profile = await call(fetchImpl, `${API}/profile`, { ...opts, headers: { Authorization: `Bearer ${t.access_token}` } });
      return {
        refreshToken: t.refresh_token,
        accessToken: t.access_token,
        expiresIn: Number(t.expires_in) || 3600,
        scopes: String(t.scope || '')
          .split(' ')
          .filter(Boolean),
        account: profile.emailAddress || null,
      };
    },

    async refresh(refreshToken) {
      const t = await call(fetchImpl, TOKEN_URL, {
        ...opts,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }),
      });
      return { accessToken: t.access_token, expiresIn: Number(t.expires_in) || 3600, refreshToken: t.refresh_token || null };
    },

    async revoke(refreshToken) {
      await call(fetchImpl, REVOKE_URL, {
        ...opts,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ token: refreshToken }),
        retries: 0,
      });
    },

    /** Message ids received since `since`, one page at a time. */
    async listMessages(token, { since, pageToken = null }) {
      const id = await resolveLabel(token);
      const after = Math.floor(since.getTime() / 1000);
      const q = new URLSearchParams({ labelIds: id, q: `${query} after:${after}`.trim(), maxResults: '50' });
      if (pageToken) q.set('pageToken', pageToken);
      const data = await call(fetchImpl, `${API}/messages?${q}`, { ...opts, headers: { Authorization: `Bearer ${token}` } });
      return { ids: (data.messages || []).map((m) => m.id), next: data.nextPageToken || null };
    },

    async getMessage(token, id) {
      const m = await call(fetchImpl, `${API}/messages/${encodeURIComponent(id)}?format=full`, { ...opts, headers: { Authorization: `Bearer ${token}` } });
      const headers = m.payload?.headers;
      return {
        id: m.id,
        from: addressOf(header(headers, 'from')),
        subject: header(headers, 'subject').slice(0, 200),
        receivedAt: m.internalDate ? new Date(Number(m.internalDate)) : null,
        attachments: fileParts(m.payload),
      };
    },

    async download(token, messageId, att) {
      const auth = { ...opts, headers: { Authorization: `Bearer ${token}` } };
      if (att.attachmentId) {
        try {
          const a = await call(fetchImpl, `${API}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(att.attachmentId)}`, auth);
          return Buffer.from(String(a.data || ''), 'base64url');
        } catch (err) {
          // Gmail attachment ids can change between reads; look the part up again by its stable part id.
          if (!(err instanceof ProviderError && err.kind === 'notFound') || att.retried) throw err;
        }
      }
      if (att.retried) throw new ProviderError('The attachment is no longer in the message.', { kind: 'notFound' });
      // Small parts can be inside the message itself.
      const m = await call(fetchImpl, `${API}/messages/${encodeURIComponent(messageId)}?format=full`, auth);
      const part = (function find(p) {
        if (!p) return null;
        if (String(p.partId ?? '') === att.key) return p;
        for (const c of p.parts || []) {
          const f = find(c);
          if (f) return f;
        }
        return null;
      })(m.payload);
      if (!part) throw new ProviderError('The attachment is no longer in the message.', { kind: 'notFound' });
      if (part.body?.attachmentId) return this.download(token, messageId, { ...att, attachmentId: part.body.attachmentId, retried: true });
      return Buffer.from(String(part.body?.data || ''), 'base64url');
    },
  };
}
