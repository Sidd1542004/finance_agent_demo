// The business's time zone (TIME_ZONE, default Australia/Sydney). "Today",
// due dates, overdue, report months and dates in report text all follow it,
// not the server's clock: on Vercel the server runs in UTC.
//
// Plain Intl, no date library.

export const DEFAULT_TIME_ZONE = 'Australia/Sydney';

export function isTimeZone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

let warned = null;

/** TIME_ZONE when it is a real IANA zone, otherwise Australia/Sydney. Read at call time. */
export function businessTimeZone() {
  const tz = String(process.env.TIME_ZONE || '').trim();
  if (!tz) return DEFAULT_TIME_ZONE;
  if (isTimeZone(tz)) return tz;
  if (warned !== tz) {
    console.warn(`TIME_ZONE "${tz}" is not a known time zone. Using ${DEFAULT_TIME_ZONE}.`);
    warned = tz;
  }
  return DEFAULT_TIME_ZONE;
}

const formatters = new Map();
function partsFormatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  }
  return formatters.get(tz);
}

/** The wall-clock date and time in `tz` for an instant. */
export function zonedParts(date, tz = businessTimeZone()) {
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(date))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out; // { year, month, day, hour, minute, second }
}

const pad = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD in `tz`. */
export const isoDateIn = (date, tz = businessTimeZone()) => {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

/** YYYY-MM in `tz`. */
export const monthIn = (date, tz = businessTimeZone()) => isoDateIn(date, tz).slice(0, 7);

// How far `tz` is ahead of UTC at an instant, in milliseconds.
function offsetMs(instant, tz) {
  const p = zonedParts(instant, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
}

/** The instant midnight starts on a calendar date in `tz` (month and day may overflow, as with Date.UTC). */
export function startOfDayIn(year, month, day, tz = businessTimeZone()) {
  const wall = Date.UTC(year, month - 1, day);
  let guess = wall - offsetMs(wall, tz);
  // Once more, in case the offset differs at the guess (a daylight saving change).
  guess = wall - offsetMs(guess, tz);
  return new Date(guess);
}
