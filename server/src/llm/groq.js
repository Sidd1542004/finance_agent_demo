// Minimal Groq client. Groq's API is OpenAI-compatible, so this is one fetch
// call and needs no SDK. Swapping to another provider means changing this file only.
//
// Busy or briefly unavailable (429, 5xx, a network error or a timeout): tried
// again up to twice, waiting as long as Groq's Retry-After asks (capped), or a
// short backoff. A bad request or a bad key (400, 401, other 4xx) is never
// retried. Everything, waits included, fits in `budgetMs`, which stays under
// Vercel's 60-second function limit with room for the rest of the request.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export const RETRY = { retries: 2, budgetMs: 45000, baseDelayMs: 600, maxDelayMs: 8000 };

// A retry is only started if at least this much of the budget is left for it.
const MIN_ATTEMPT_MS = 5000;

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Seconds ("7"), or an HTTP date. Returns milliseconds, or null.
export function retryAfterMs(value, now = Date.now()) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

const retryable = (status) => status === 429 || (status >= 500 && status <= 599);

/**
 * Send one chat request. `body` is the request body without the model.
 * @returns the parsed object from the message content
 */
export async function groqChat({
  apiKey,
  model,
  body,
  fetchImpl = fetch,
  timeoutMs = 30000,
  retries = RETRY.retries,
  budgetMs = RETRY.budgetMs,
  sleep = sleepFor,
  now = Date.now,
}) {
  if (!apiKey) throw new Error('GROQ_API_KEY is not set.');

  const deadline = now() + budgetMs;
  let attempt = 0;
  for (;;) {
    const left = deadline - now();
    let res = null;
    let failure = null; // a message for an error that may be retried
    let wait = null;
    try {
      res = await fetchImpl(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, ...body }),
        signal: AbortSignal.timeout(Math.max(1000, Math.min(timeoutMs, left))),
      });
    } catch (err) {
      failure = `Could not reach Groq (${err?.name === 'TimeoutError' ? 'timed out' : err?.message || 'network error'}).`;
    }

    if (res && !res.ok) {
      let message = '';
      try {
        message = (await res.json())?.error?.message || '';
      } catch {
        /* body was not JSON */
      }
      if (res.status === 401) throw new Error('Groq rejected the API key. Check GROQ_API_KEY in server/.env.');
      const text =
        res.status === 429 ? 'Groq rate limit reached. Wait a moment and process the invoice again.' : `Groq returned an error (${res.status})${message ? `: ${message}` : '.'}`;
      if (!retryable(res.status)) throw new Error(text);
      failure = text;
      wait = retryAfterMs(res.headers?.get?.('retry-after'));
    }

    if (!failure) return readContent(res);

    // Try again only if there is time for the wait and a reasonable attempt after it.
    attempt += 1;
    const delay = Math.min(RETRY.maxDelayMs, wait ?? RETRY.baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 200));
    if (attempt > retries || now() + delay + MIN_ATTEMPT_MS > deadline) throw new Error(failure);
    await sleep(delay);
  }
}

async function readContent(res) {
  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`Could not read Groq's response (${err?.message || 'network error'}).`);
  }
  const content = data?.choices?.[0]?.message?.content;
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new Error('The AI reader returned an answer that was not valid JSON.');
  }
}

/**
 * Ask the model for a JSON object.
 * @returns the parsed object
 */
export function groqJson({ apiKey, model, system, user, ...options }) {
  return groqChat({
    apiKey,
    model,
    ...options,
    body: {
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
  });
}
