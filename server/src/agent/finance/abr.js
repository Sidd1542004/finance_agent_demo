// Optional Australian Business Register (ABR) lookup.
//
// Only used when ABR_GUID is set in server/.env. A GUID is free from
// https://abr.business.gov.au/Tools/WebServices. Without one, every ABN is
// reported as "valid number, not verified with the register" - never as verified.
//
// Uses the ABR JSON service (AbnDetails), which answers in JSONP:
//   callback({"Abn":"...","AbnStatus":"Active","EntityName":"...","Gst":"2000-07-01",...})

const URL = 'https://abr.business.gov.au/json/AbnDetails.aspx';
const cache = new Map();

export function parseAbrResponse(body) {
  const m = String(body ?? '').match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
  const data = JSON.parse(m ? m[1] : body);
  if (data.Message && !data.Abn) return { status: 'not_found', message: data.Message };
  const active = String(data.AbnStatus || '').toLowerCase() === 'active';
  return {
    status: active ? 'active' : 'cancelled',
    entityName: data.EntityName || null,
    gstFrom: data.Gst || null, // date GST registration started, empty if not registered
    message: data.Message || null,
  };
}

/**
 * @returns null when no GUID is configured, otherwise async (abn) => result where
 *          result.status is 'active' | 'cancelled' | 'not_found' | 'error'.
 *          Never throws: a failed lookup is 'error' and the ABN stays unverified.
 */
export function createAbrLookup({ abrGuid, fetchImpl = fetch, timeoutMs = 8000 }) {
  if (!abrGuid) return null;
  return async (abn) => {
    if (cache.has(abn)) return cache.get(abn);
    try {
      const res = await fetchImpl(`${URL}?abn=${encodeURIComponent(abn)}&callback=callback&guid=${encodeURIComponent(abrGuid)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { status: 'error', message: `the register returned ${res.status}` };
      const result = parseAbrResponse(await res.text());
      cache.set(abn, result);
      return result;
    } catch (err) {
      return { status: 'error', message: err?.name === 'TimeoutError' ? 'the register did not answer in time' : 'the register could not be reached' };
    }
  };
}
