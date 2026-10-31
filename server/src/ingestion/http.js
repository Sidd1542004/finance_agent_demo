// HTTP calls to the mailbox providers, with errors sorted into what the
// ingestion service can act on:
//   auth       401/403, or an OAuth invalid_grant: the access was revoked or
//              has expired. Polling stops until an administrator reconnects.
//   transient  429, 5xx, timeouts, network errors: retried later.
//   notFound   404: the message or attachment is gone.
//   other      a permanent provider error.
// Messages never include tokens, codes or response bodies beyond a short reason.

export class ProviderError extends Error {
  constructor(message, { status = null, kind = 'other', retryAfterMs = null, code = null } = {}) {
    super(message);
    this.status = status;
    this.kind = kind; // 'auth' | 'transient' | 'notFound' | 'other'
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
  get transient() {
    return this.kind === 'transient';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function retryAfter(value) {
  if (!value) return null;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// A short, safe reason from a provider's JSON error (Google and Microsoft shapes).
function reasonOf(body) {
  const e = body?.error;
  const text = typeof e === 'string' ? e : e?.message || e?.code || body?.error_description || '';
  return String(text).replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * fetch with a timeout, classification and a few quick retries for transient
 * errors. `as`: 'json' | 'buffer'. `retries`: extra attempts for 429/5xx/network.
 */
export async function call(fetchImpl, url, { method = 'GET', headers = {}, body, as = 'json', timeoutMs = 15000, retries = 2, label = 'The mail provider' } = {}) {
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const failure = new ProviderError(timeout ? `${label} did not answer in time.` : `${label} could not be reached.`, { kind: 'transient' });
      if (attempt >= retries) throw failure;
      attempt += 1;
      await sleep(250 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
      const text = await res.text();
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        throw new ProviderError(`${label} sent an answer that could not be read.`, { status: res.status });
      }
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    const reason = reasonOf(data);
    const status = res.status;
    if (status === 429 || status >= 500) {
      const wait = retryAfter(res.headers?.get?.('retry-after'));
      const failure = new ProviderError(
        status === 429 ? `${label} is rate limiting requests. It will be tried again later.` : `${label} is unavailable (${status}). It will be tried again later.`,
        {
          status,
          kind: 'transient',
          retryAfterMs: wait,
        },
      );
      // Only wait briefly here; longer waits are left to the next sync.
      if (attempt >= retries || (wait !== null && wait > 3000)) throw failure;
      attempt += 1;
      await sleep(wait ?? 300 * 2 ** attempt);
      continue;
    }
    if (status === 400 && data?.error === 'invalid_grant') {
      throw new ProviderError('The mailbox access was revoked or has expired. An administrator needs to reconnect the mailbox.', { status, kind: 'auth', code: 'invalid_grant' });
    }
    if (status === 401 || status === 403) {
      throw new ProviderError(`${label} refused access (${status})${reason ? `: ${reason}` : ''}.`, { status, kind: 'auth', code: data?.error?.code || data?.error || null });
    }
    if (status === 404) throw new ProviderError(`${label} could not find it (404).`, { status, kind: 'notFound' });
    throw new ProviderError(`${label} returned an error (${status})${reason ? `: ${reason}` : ''}.`, { status });
  }
}

export const form = (fields) => new URLSearchParams(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
