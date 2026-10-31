// Microsoft Outlook / Exchange Online (Microsoft Graph, OAuth 2.0 with PKCE).
// Delegated, read-only: Mail.Read (read messages and attachments) and
// offline_access (a refresh token, so polling works without the person).
// openid + email only let us show which mailbox is connected. Nothing is sent,
// moved, flagged or deleted.

import { call, form, ProviderError } from '../http.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
export const OUTLOOK_SCOPES = ['openid', 'email', 'offline_access', 'https://graph.microsoft.com/Mail.Read'];

// The email address in an id_token, for display only (it comes straight from the token endpoint over TLS).
function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return payload.email || payload.preferred_username || null;
  } catch {
    return null;
  }
}

export function createOutlook({ clientId, clientSecret, tenant = 'organizations', folder = 'inbox' }, fetchImpl = fetch) {
  const opts = { label: 'Microsoft Graph' };
  const login = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
  const tokenCall = (fields) =>
    call(fetchImpl, `${login}/token`, {
      ...opts,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: clientId, client_secret: clientSecret, scope: OUTLOOK_SCOPES.join(' '), ...fields }),
      retries: fields.grant_type === 'authorization_code' ? 0 : 2,
    });

  return {
    name: 'outlook',
    label: 'Outlook (Microsoft 365)',
    scopes: OUTLOOK_SCOPES,
    configured: Boolean(clientId && clientSecret),
    where: `folder "${folder}"`,

    authUrl({ state, challenge, redirectUri }) {
      const q = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: OUTLOOK_SCOPES.join(' '),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      return `${login}/authorize?${q}`;
    },

    async exchangeCode({ code, verifier, redirectUri }) {
      const t = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
      if (!t.refresh_token)
        throw new ProviderError('Microsoft did not return a refresh token (offline_access). Check the app registration and connect again.', { code: 'no_refresh_token' });
      return {
        refreshToken: t.refresh_token,
        accessToken: t.access_token,
        expiresIn: Number(t.expires_in) || 3600,
        scopes: String(t.scope || '')
          .split(' ')
          .filter(Boolean),
        account: emailFromIdToken(t.id_token),
      };
    },

    // Microsoft rotates refresh tokens: the new one is returned and stored.
    async refresh(refreshToken) {
      const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken });
      return { accessToken: t.access_token, expiresIn: Number(t.expires_in) || 3600, refreshToken: t.refresh_token || null };
    },

    // Graph has no token revocation endpoint for a single refresh token; the
    // stored token is deleted, and the person can remove the app's consent at
    // https://myapps.microsoft.com (documented).
    async revoke() {},

    async listMessages(token, { since, pageToken = null }) {
      const url =
        pageToken ||
        `${GRAPH}/me/mailFolders/${encodeURIComponent(folder)}/messages?${new URLSearchParams({
          $filter: `receivedDateTime ge ${since.toISOString()} and hasAttachments eq true`,
          $orderby: 'receivedDateTime asc',
          $select: 'id',
          $top: '50',
        })}`;
      if (pageToken && !pageToken.startsWith(`${GRAPH}/`)) throw new ProviderError('Unexpected paging link from Microsoft Graph.');
      const data = await call(fetchImpl, url, { ...opts, headers: { Authorization: `Bearer ${token}` } });
      return { ids: (data.value || []).map((m) => m.id), next: data['@odata.nextLink'] || null };
    },

    async getMessage(token, id) {
      const auth = { ...opts, headers: { Authorization: `Bearer ${token}` } };
      const m = await call(fetchImpl, `${GRAPH}/me/messages/${encodeURIComponent(id)}?$select=id,from,subject,receivedDateTime`, auth);
      const a = await call(fetchImpl, `${GRAPH}/me/messages/${encodeURIComponent(id)}/attachments?$select=id,name,contentType,size,isInline`, auth);
      return {
        id: m.id,
        from: String(m.from?.emailAddress?.address || '').toLowerCase(),
        subject: String(m.subject || '').slice(0, 200),
        receivedAt: m.receivedDateTime ? new Date(m.receivedDateTime) : null,
        attachments: (a.value || [])
          // Only files: not attached emails (itemAttachment) or cloud links (referenceAttachment).
          .filter((x) => !x['@odata.type'] || x['@odata.type'] === '#microsoft.graph.fileAttachment')
          .map((x) => ({
            key: String(x.id),
            attachmentId: String(x.id),
            filename: x.name || '',
            mimeType: String(x.contentType || '').toLowerCase(),
            size: Number(x.size) || 0,
            inline: Boolean(x.isInline),
          })),
      };
    },

    async download(token, messageId, att) {
      return call(fetchImpl, `${GRAPH}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(att.attachmentId)}/$value`, {
        ...opts,
        headers: { Authorization: `Bearer ${token}` },
        as: 'buffer',
        timeoutMs: 30000,
      });
    },
  };
}
