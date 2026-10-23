// When a bank payment may run: business days, bank holidays and the daily
// cut-off, in the business's time zone (TIME_ZONE). Plain functions.
//
// A date that is not a business day, or a time after the cut-off, is refused
// with the next valid date and time suggested. Nothing is moved silently.

import { zonedParts, startOfDayIn, businessTimeZone } from './timeZone.js';
import { AU_NATIONAL_HOLIDAYS } from './auHolidays.js';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LONG_DAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "Mon-Fri", "Mon,Tue,Thu" or "Mon-Sun" -> ISO weekday numbers (1 = Monday). */
export function parseBusinessDays(spec = 'Mon-Fri') {
  const out = new Set();
  for (const part of String(spec || 'Mon-Fri')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [a, b] = part.split('-').map((s) => DAY_NAMES.findIndex((d) => d.toLowerCase() === s.trim().slice(0, 3).toLowerCase()) + 1);
    if (!a) continue;
    // A range wraps past Sunday if needed ("Sat-Mon").
    let d = a;
    for (let i = 0; i < 7; i += 1) {
      out.add(d);
      if (!b || d === b) break;
      d = (d % 7) + 1;
    }
  }
  return out.size ? out : new Set([1, 2, 3, 4, 5]);
}

const toMinutes = (hhmm) => {
  const m = HHMM.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10);
};
const weekdayOf = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return w === 0 ? 7 : w;
};
const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return isoOf(y, m, d + n);
};

/**
 * @param timeZone      IANA zone (TIME_ZONE)
 * @param businessDays  "Mon-Fri" (BUSINESS_DAYS)
 * @param holidays      ["YYYY-MM-DD", ...] (BANK_HOLIDAYS); empty: Australian national holidays
 * @param cutoff        "15:00" (PAYMENT_CUTOFF): the last time a payment can run on a business day
 * @param defaultTime   "09:00" (PAYMENT_DEFAULT_TIME)
 */
export function createCalendar({ timeZone = businessTimeZone(), businessDays = 'Mon-Fri', holidays = [], cutoff = '15:00', defaultTime = '09:00' } = {}) {
  const days = parseBusinessDays(businessDays);
  const holidayNames = holidays.length ? Object.fromEntries(holidays.filter((h) => ISO.test(h)).map((h) => [h, 'Bank holiday'])) : { ...AU_NATIONAL_HOLIDAYS };
  const cutoffMin = toMinutes(cutoff) ?? 15 * 60;
  const defaultMin = Math.min(toMinutes(defaultTime) ?? 9 * 60, cutoffMin);
  const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

  /** Why a date is not a business day, or null. */
  function closedReason(iso) {
    if (holidayNames[iso]) return `${iso} is a bank holiday (${holidayNames[iso]})`;
    if (!days.has(weekdayOf(iso))) return `${iso} is a ${LONG_DAY[weekdayOf(iso) - 1]}, not a business day`;
    return null;
  }
  const isBusinessDay = (iso) => ISO.test(iso) && !closedReason(iso);
  function nextBusinessDay(iso) {
    let d = iso;
    for (let i = 0; i < 400; i += 1) {
      if (isBusinessDay(d)) return d;
      d = addDays(d, 1);
    }
    throw new Error('No business day in the next 400 days. Check BUSINESS_DAYS and BANK_HOLIDAYS.');
  }
  /** The instant a wall-clock date and time happen in the time zone. */
  function instant(iso, time) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(startOfDayIn(y, m, d, timeZone).getTime() + toMinutes(time) * 60000);
  }
  function localNow(now) {
    const p = zonedParts(now, timeZone);
    return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, minutes: p.hour * 60 + p.minute };
  }
  /** The earliest valid slot at or after `now`. */
  function nextSlot(now = new Date()) {
    const { date, minutes } = localNow(now);
    if (isBusinessDay(date) && minutes <= cutoffMin) {
      const at = Math.max(minutes, defaultMin);
      return { date, time: hhmm(at) };
    }
    return { date: nextBusinessDay(addDays(date, 1)), time: hhmm(defaultMin) };
  }

  /**
   * Check a chosen date and time for a bank payment.
   * Returns { ok: true, runAt, date, time } or { ok: false, problem, suggestion: { date, time } }.
   */
  function validateSlot({ date, time, now = new Date() }) {
    const t = time || hhmm(defaultMin);
    if (!ISO.test(date || '') || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return { ok: false, problem: 'Choose a payment date.', suggestion: nextSlot(now) };
    if (toMinutes(t) === null) return { ok: false, problem: 'Choose a time as HH:MM.', suggestion: nextSlot(now) };
    const local = localNow(now);
    const closed = closedReason(date);
    if (date < local.date) return { ok: false, problem: `${date} is in the past.`, suggestion: nextSlot(now) };
    if (closed) {
      const next = nextBusinessDay(date);
      return { ok: false, problem: `Payments cannot run on ${closed}.`, suggestion: { date: next, time: hhmm(defaultMin) } };
    }
    if (toMinutes(t) > cutoffMin) {
      const next = nextBusinessDay(addDays(date, 1));
      return { ok: false, problem: `${t} is after the ${hhmm(cutoffMin)} cut-off (${timeZone}).`, suggestion: { date: next, time: hhmm(defaultMin) } };
    }
    if (date === local.date && local.minutes > cutoffMin) {
      return { ok: false, problem: `Today's ${hhmm(cutoffMin)} cut-off (${timeZone}) has passed.`, suggestion: nextSlot(now) };
    }
    // Today at a time that has already gone: it runs at the next tick, before the cut-off.
    const runAt = instant(date, t);
    return { ok: true, date, time: t, runAt: runAt < now ? now : runAt };
  }

  /**
   * May a due payment run right now? A job that missed its day (a scheduler
   * outage, or a tick after the cut-off) waits for the next business day.
   * Returns { ok: true } or { ok: false, reason, nextAt }.
   */
  function executionWindow(now = new Date()) {
    const { date, minutes } = localNow(now);
    const closed = closedReason(date);
    if (!closed && minutes <= cutoffMin) return { ok: true };
    const next = nextBusinessDay(closed ? date : addDays(date, 1));
    return { ok: false, reason: closed ? `Today is not a business day (${closed}).` : `After today's ${hhmm(cutoffMin)} cut-off.`, nextAt: instant(next, hhmm(defaultMin)) };
  }

  return {
    timeZone,
    cutoff: hhmm(cutoffMin),
    defaultTime: hhmm(defaultMin),
    businessDays: [...days].sort().map((d) => DAY_NAMES[d - 1]),
    holidays: holidayNames,
    isBusinessDay,
    closedReason,
    nextBusinessDay,
    nextSlot,
    instant,
    validateSlot,
    executionWindow,
  };
}
