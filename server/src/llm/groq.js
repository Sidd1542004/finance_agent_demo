// Minimal Groq client. Groq's API is OpenAI-compatible, so this is one fetch
// call and needs no SDK. Swapping to another provider means changing this file only.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Ask the model for a JSON object.
 * @returns the parsed object
 */
export async function groqJson({ apiKey, model, system, user, fetchImpl = fetch, timeoutMs = 30000 }) {
  if (!apiKey) throw new Error('GROQ_API_KEY is not set.');

  let res;
  try {
    res = await fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Could not reach Groq (${err?.name === 'TimeoutError' ? 'timed out' : err?.message || 'network error'}).`);
  }

  if (!res.ok) {
    let message = '';
    try {
      message = (await res.json())?.error?.message || '';
    } catch {
      /* body was not JSON */
    }
    if (res.status === 401) throw new Error('Groq rejected the API key. Check GROQ_API_KEY in server/.env.');
    if (res.status === 429) throw new Error('Groq rate limit reached. Wait a moment and process the invoice again.');
    throw new Error(`Groq returned an error (${res.status})${message ? `: ${message}` : '.'}`);
  }

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
