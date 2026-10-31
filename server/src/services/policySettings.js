// The agent's adjustable policy: which values an administrator may change on
// the Admin screen (sliders), their limits, and how saved values are stored
// and loaded.
//
// There is still ONE policy object: config.policy, which every agent and rule
// already reads. Its starting values come from the environment (config.js).
// Saved values (one Setting document, _id 'policy') are laid over it, so a
// change takes effect without a restart. Removing them (Reset to defaults)
// brings back the environment's values.
//
// On Vercel every warm instance holds its own copy of config.policy, so each
// request re-reads the saved values when the copy is older than REFRESH_MS
// (see refreshPolicy, called from app.js). The instance that saved a change
// applies it at once.
//
// None of these values approves anything: they only decide whether an invoice
// is eligible for a person's approval review, or goes to a person with reasons.

import { config } from '../config.js';
import { Setting } from '../models/index.js';
import { HttpError, recordAudit } from './runs.js';

export const POLICY_SETTING_ID = 'policy';
export const REFRESH_MS = 5000;

// `format: 'fraction'` values are stored from 0 to 1 and shown as percentages.
export const POLICY_SLIDERS = Object.freeze([
  {
    key: 'matchThreshold',
    label: 'Match score for approval review',
    help: 'An invoice scoring below this goes to a person (On Hold). At or above it, it is only eligible for a person to approve.',
    min: 50,
    max: 100,
    step: 1,
    format: 'percent',
  },
  {
    key: 'minConfidence',
    label: 'Minimum invoice reading confidence',
    help: 'An invoice read with less confidence than this goes to Needs Review.',
    min: 0.5,
    max: 1,
    step: 0.01,
    format: 'fraction',
  },
  {
    key: 'priceTolerancePct',
    label: 'Unit price may differ from the purchase order by',
    help: 'A larger difference fails the price check and holds the invoice.',
    min: 0,
    max: 10,
    step: 0.5,
    format: 'percent',
  },
  {
    key: 'emailMinConfidence',
    label: 'Minimum supplier email reading confidence',
    help: 'An email read with less confidence than this is never answered automatically.',
    min: 0.5,
    max: 1,
    step: 0.01,
    format: 'fraction',
  },
]);

const KEYS = POLICY_SLIDERS.map((s) => s.key);
const byKey = Object.fromEntries(POLICY_SLIDERS.map((s) => [s.key, s]));

// The environment's values, captured before anything is laid over them.
const ENV_DEFAULTS = Object.freeze(Object.fromEntries(KEYS.map((k) => [k, config.policy[k]])));
export const policyDefaults = () => ({ ...ENV_DEFAULTS });

// Round to the slider's step, so 0.1 + 0.2 style float noise never fails a check.
const decimals = (step) => (String(step).split('.')[1] || '').length;
const roundTo = (value, step) => Number(value.toFixed(decimals(step)));

/** Why one value is not acceptable for its slider, or null. */
export function valueProblem(key, value) {
  const s = byKey[key];
  if (!s) return `"${key}" is not an adjustable setting.`;
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${s.label} must be a number.`;
  if (value < s.min || value > s.max) {
    const show = (n) => (s.format === 'fraction' ? `${Math.round(n * 100)}%` : `${n}%`);
    return `${s.label} must be between ${show(s.min)} and ${show(s.max)}.`;
  }
  const steps = (value - s.min) / s.step;
  if (Math.abs(steps - Math.round(steps)) > 1e-6) return `${s.label} must be in steps of ${s.format === 'fraction' ? `${roundTo(s.step * 100, 2)}%` : `${s.step}%`}.`;
  return null;
}

/**
 * Check what a person sent. Returns { values, problems }: `values` holds only
 * the known keys, rounded to their step. Nothing is saved when there are problems.
 */
export function validatePolicyInput(input) {
  const problems = [];
  const values = {};
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) {
    return { values, problems: ['Send at least one setting to change.'] };
  }
  for (const [key, value] of Object.entries(input)) {
    const problem = valueProblem(key, value);
    if (problem) problems.push(problem);
    else values[key] = roundTo(value, byKey[key].step);
  }
  return { values, problems };
}

// Saved values that are still acceptable. A value saved under older limits
// that are now narrower is dropped (the default applies), never used.
function usable(saved) {
  const out = {};
  for (const [key, value] of Object.entries(saved || {})) if (!valueProblem(key, value)) out[key] = value;
  return out;
}

let loadedAt = 0;
let current = { values: {}, updatedBy: null, updatedAt: null };

/** Lay `saved` over the environment's defaults, in the one policy object. */
export function applyPolicy(saved = {}) {
  const values = usable(saved);
  Object.assign(config.policy, ENV_DEFAULTS, values);
  return values;
}

/** Read the saved values from the database and apply them. */
export async function loadPolicy() {
  const doc = await Setting.findById(POLICY_SETTING_ID).lean();
  const saved = doc?.value || {};
  current = { values: applyPolicy(saved.values), updatedBy: saved.updatedBy || null, updatedAt: saved.updatedAt || null };
  loadedAt = Date.now();
  return current;
}

/**
 * Re-read the saved values if this instance's copy is older than REFRESH_MS.
 * A database error keeps the values already in use (logged, never thrown).
 */
export async function refreshPolicy({ now = Date.now(), log = console } = {}) {
  if (now - loadedAt < REFRESH_MS) return;
  try {
    await loadPolicy();
  } catch (err) {
    loadedAt = now; // try again after REFRESH_MS, not on every request
    log.error?.(`Could not load the saved policy settings; keeping the current values: ${err?.message}`);
  }
}

/** What the Admin screen needs: each slider with its limits, value and default. */
export function policyView() {
  return {
    settings: POLICY_SLIDERS.map((s) => ({ ...s, value: config.policy[s.key], default: ENV_DEFAULTS[s.key], saved: Object.hasOwn(current.values, s.key) })),
    updatedBy: current.updatedBy,
    updatedAt: current.updatedAt,
  };
}

const shown = (key, value) => (byKey[key].format === 'fraction' ? `${roundTo(value * 100, 2)}%` : `${value}%`);
const describe = (from, to) =>
  KEYS.filter((k) => from[k] !== to[k])
    .map((k) => `${byKey[k].label}: ${shown(k, from[k])} to ${shown(k, to[k])}`)
    .join('; ');

async function store(values, user, action) {
  await loadPolicy(); // the latest saved values, in case another instance changed them
  const before = { ...config.policy };
  const merged = action === 'policy_reset' ? {} : { ...current.values, ...values };
  const value = { values: merged, updatedBy: user.name, updatedById: user.id, updatedAt: new Date().toISOString() };
  await Setting.updateOne({ _id: POLICY_SETTING_ID }, { $set: { value } }, { upsert: true });
  current = { values: applyPolicy(merged), updatedBy: value.updatedBy, updatedAt: value.updatedAt };
  loadedAt = Date.now();
  const change = describe(before, config.policy);
  await recordAudit({
    subjectKind: 'system',
    subjectId: POLICY_SETTING_ID,
    actor: user.name,
    actorId: user.id,
    action,
    detail: change || 'No value changed.',
  });
  return policyView();
}

/** An administrator saves new values. Refused as a whole if any value is out of bounds. */
export async function savePolicy(input, user) {
  const { values, problems } = validatePolicyInput(input);
  if (problems.length) throw new HttpError(400, problems.join(' '));
  return store(values, user, 'policy_changed');
}

/** Back to the environment's values. */
export const resetPolicy = (user) => store({}, user, 'policy_reset');
