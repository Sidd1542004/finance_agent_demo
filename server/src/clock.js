// The time stamped on history (audit entries, invoice and payment events,
// agent steps, record timestamps). Normally the real time. While the demo month
// loads (services/demo.js), a timeline set for that load gives each step a date
// inside the demo month, so its history reads in order: an invoice is received
// after it was issued, and approved before its payment date.
//
// Only stamps read this. Business rules (due dates, payment calendars, checks)
// keep using the real clock, so the timeline cannot change a status or amount.

import { AsyncLocalStorage } from 'node:async_hooks';

const timelines = new AsyncLocalStorage();

/** The time to stamp: the active timeline's next moment, else `real` (default: now). */
export function stamp(real = new Date()) {
  const timeline = timelines.getStore();
  return timeline ? timeline.next() : real;
}

export const stampIso = (real) => stamp(real).toISOString();

/**
 * A timeline for one run of `fn`: `at(iso)` moves it to a moment; each stamp after
 * that is one second later than the one before, so stamps keep the order things happened in.
 */
export function createTimeline() {
  let ms = null;
  return {
    at(iso) {
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t)) throw new Error(`Not a time: ${iso}`);
      ms = t;
    },
    next() {
      if (ms === null) return new Date();
      ms += 1000;
      return new Date(ms);
    },
  };
}

/** Run `fn` with `timeline` stamping everything it records (and everything that awaits inside it). */
export const withTimeline = (timeline, fn) => timelines.run(timeline, fn);
