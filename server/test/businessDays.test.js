// Business days, bank holidays and the cut-off, in the business's time zone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendar, parseBusinessDays } from '../src/agent/finance/businessDays.js';

const cal = createCalendar({ timeZone: 'Australia/Sydney', businessDays: 'Mon-Fri', holidays: [], cutoff: '15:00', defaultTime: '09:00' });
// 2026-10-22 is a Thursday. Sydney is UTC+11 (daylight saving) in October.
const sydney = (iso, hhmm) => cal.instant(iso, hhmm);

test('business days: Mon-Fri, ranges and lists', () => {
  assert.deepEqual([...parseBusinessDays('Mon-Fri')].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseBusinessDays('Mon-Sun')].sort(), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...parseBusinessDays('Sat-Mon')].sort(), [1, 6, 7]);
  assert.deepEqual([...parseBusinessDays('Mon,Wed')].sort(), [1, 3]);
  assert.deepEqual([...parseBusinessDays('nonsense')].sort(), [1, 2, 3, 4, 5], 'falls back to Mon-Fri');
});

test('weekends are refused, with the next business day suggested', () => {
  const now = sydney('2026-10-22', '10:00');
  const sat = cal.validateSlot({ date: '2026-10-24', time: '09:00', now });
  assert.equal(sat.ok, false);
  assert.match(sat.problem, /Saturday, not a business day/);
  assert.deepEqual(sat.suggestion, { date: '2026-10-26', time: '09:00' });
  assert.equal(cal.validateSlot({ date: '2026-10-25', time: '09:00', now }).suggestion.date, '2026-10-26');
});

test('Australian national public holidays are bank holidays by default', () => {
  const now = sydney('2026-12-20', '10:00');
  const xmas = cal.validateSlot({ date: '2026-12-25', time: '09:00', now });
  assert.equal(xmas.ok, false);
  assert.match(xmas.problem, /Christmas Day/);
  // 26 Dec is a Saturday, the observed Boxing Day is Monday 28th: next is Tuesday 29th.
  assert.equal(xmas.suggestion.date, '2026-12-29');
  assert.equal(cal.isBusinessDay('2026-01-26'), false, 'Australia Day');
  assert.equal(cal.isBusinessDay('2027-03-26'), false, 'Good Friday 2027');
  // A configured list replaces the built-in one.
  const custom = createCalendar({ timeZone: 'Australia/Sydney', holidays: ['2026-10-23'] });
  assert.equal(custom.isBusinessDay('2026-10-23'), false);
  assert.equal(custom.isBusinessDay('2026-12-25'), true);
});

test('the cut-off: a time after it, or today after it has passed, is refused', () => {
  const morning = sydney('2026-10-22', '10:00');
  const late = cal.validateSlot({ date: '2026-10-23', time: '16:00', now: morning });
  assert.equal(late.ok, false);
  assert.match(late.problem, /after the 15:00 cut-off/);
  assert.deepEqual(late.suggestion, { date: '2026-10-26', time: '09:00' }, 'Friday after cut-off -> Monday');

  const afternoon = sydney('2026-10-22', '15:30');
  const today = cal.validateSlot({ date: '2026-10-22', time: '14:00', now: afternoon });
  assert.equal(today.ok, false);
  assert.match(today.problem, /cut-off .* has passed/);
  assert.deepEqual(today.suggestion, { date: '2026-10-23', time: '09:00' });
});

test('valid slots run at the chosen instant; a time already passed today runs now', () => {
  const now = sydney('2026-10-22', '10:00');
  const tomorrow = cal.validateSlot({ date: '2026-10-23', time: '09:30', now });
  assert.equal(tomorrow.ok, true);
  assert.equal(tomorrow.runAt.toISOString(), '2026-10-22T22:30:00.000Z', '09:30 Sydney (UTC+11)');
  const earlier = cal.validateSlot({ date: '2026-10-22', time: '09:00', now });
  assert.equal(earlier.ok, true);
  assert.equal(earlier.runAt.getTime(), now.getTime());
  assert.equal(cal.validateSlot({ date: '2026-10-21', time: '09:00', now }).ok, false, 'the past is refused');
  assert.equal(cal.validateSlot({ date: 'soon', time: '09:00', now }).ok, false);
  assert.equal(cal.validateSlot({ date: '2026-10-23', time: '9am', now }).ok, false);
});

test('the time zone decides the date: 23:30 UTC Thursday is Friday morning in Sydney', () => {
  const now = new Date('2026-10-22T23:30:00Z'); // Fri 10:30 Sydney
  assert.deepEqual(cal.nextSlot(now), { date: '2026-10-23', time: '10:30' });
  const perth = createCalendar({ timeZone: 'Australia/Perth' });
  assert.deepEqual(perth.nextSlot(now), { date: '2026-10-23', time: '09:00' }, '07:30 Friday in Perth: the default time');
});

test('execution window: only on a business day before the cut-off; otherwise the next business morning', () => {
  assert.deepEqual(cal.executionWindow(sydney('2026-10-22', '14:59')), { ok: true });
  const after = cal.executionWindow(sydney('2026-10-23', '15:01'));
  assert.equal(after.ok, false);
  assert.equal(after.nextAt.toISOString(), sydney('2026-10-26', '09:00').toISOString());
  const weekend = cal.executionWindow(sydney('2026-10-24', '10:00'));
  assert.equal(weekend.ok, false);
  assert.match(weekend.reason, /not a business day/);
  // Across the daylight saving change (Sydney goes to UTC+11 on 4 Oct 2026).
  assert.equal(cal.instant('2026-10-02', '09:00').toISOString(), '2026-10-01T23:00:00.000Z');
  assert.equal(cal.instant('2026-10-05', '09:00').toISOString(), '2026-10-04T22:00:00.000Z');
});
