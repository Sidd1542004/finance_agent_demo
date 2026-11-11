// The agent's adjustable policy: the Settings screen's three sliders and one switch.
//
// ONE PolicySettings document in MongoDB (_id 'policy'). The environment's
// values (MATCH_THRESHOLD, PRICE_TOLERANCE_PCT, MIN_CONFIDENCE) are only the
// initial defaults, used to create it the first time it is read. After that
// only an administrator changes it, with a reason, and only from the version
// they looked at (compare-and-set on `version`: someone else's save first is a
// 409). Every change is in the audit log (subject 'settings').
//
// The values are laid over config.policy, the one object every agent and rule
// reads, so there is no second copy of the policy. Each warm instance re-reads
// the document when its copy is older than REFRESH_MS (refreshPolicy, from
// app.js); the instance that saved applies it at once. Invoices processed (or
// processed again) after a save use the new values; existing invoices are not
// re-evaluated. Each invoice run keeps a snapshot of the values and the version
// it was checked against (policySnapshot, services/invoices.js).
//
// None of these values approves anything, and none can switch off a mandatory
// check: ai_reader_unavailable, duplicates, arithmetic and the rest still block.
// The one switch, requireDeliverySlip, only decides whether goods with no
// delivery slip block approval; off, they are still marked as not checked.

import { config } from '../config.js';
import { PolicySettings } from '../models/index.js';
import { HttpError, recordAudit } from './runs.js';
import { requireActor } from './actor.js';
import { sampleLedger } from '../integrations/sampleLedger.js';

export const POLICY_ID = 'policy';
export const REFRESH_MS = 5000;

// The first three are percentages (confidenceFloor 99 is config.policy.minConfidence 0.99);
// requireDeliverySlip is a switch (type 'switch'), on by default.
export const POLICY_FIELDS = Object.freeze([
  {
    key: 'matchThreshold',
    label: 'Match score for approval review',
    help: 'An invoice that scores below this goes to a person (On Hold). At or above it, it is only eligible for a person to approve.',
    min: 85,
    max: 100,
    step: 1,
  },
  {
    key: 'priceTolerancePct',
    label: 'Unit price may differ from the purchase order by',
    help: 'A larger difference from the purchase order price fails the price check and holds the invoice.',
    min: 0,
    max: 10,
    step: 0.5,
  },
  {
    key: 'confidenceFloor',
    label: 'Minimum invoice reading confidence',
    help: 'An invoice read with less confidence than this goes to Needs Review.',
    min: 50,
    max: 100,
    step: 1,
  },
  {
    key: 'requireDeliverySlip',
    type: 'switch',
    label: 'Require delivery slip for goods',
    help: 'On: goods invoiced against a purchase order with no delivery slip (goods receipt) go to Needs Review and cannot be approved. Off: they are only marked as not checked. Service lines never need one.',
  },
]);
const KEYS = POLICY_FIELDS.map((f) => f.key);
const byKey = Object.fromEntries(POLICY_FIELDS.map((f) => [f.key, f]));

const decimals = (step) => (String(step).split('.')[1] || '').length;
const roundTo = (value, step) => Number(value.toFixed(decimals(step)));
const clampTo = (f, v) => roundTo(Math.min(f.max, Math.max(f.min, Math.round(v / f.step) * f.step)), f.step);

// The environment's values, as the initial defaults (kept inside the limits).
const ENV_DEFAULTS = Object.freeze({
  matchThreshold: clampTo(byKey.matchThreshold, config.policy.matchThreshold),
  priceTolerancePct: clampTo(byKey.priceTolerancePct, config.policy.priceTolerancePct),
  confidenceFloor: clampTo(byKey.confidenceFloor, config.policy.minConfidence * 100),
  requireDeliverySlip: config.policy.requireDeliverySlip !== false,
});
export const policyDefaults = () => ({ ...ENV_DEFAULTS });

/** Why one value is not acceptable, or null. */
export function valueProblem(key, value) {
  const f = byKey[key];
  if (!f) return `"${key}" is not a policy setting.`;
  if (f.type === 'switch') return typeof value === 'boolean' ? null : `${f.label} must be on or off (true or false).`;
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${f.label} must be a number.`;
  if (value < f.min || value > f.max) return `${f.label} must be between ${f.min}% and ${f.max}%.`;
  const steps = (value - f.min) / f.step;
  if (Math.abs(steps - Math.round(steps)) > 1e-9) return f.step === 1 ? `${f.label} must be a whole number.` : `${f.label} must be in steps of ${f.step}%.`;
  return null;
}

/**
 * Check a save request: { matchThreshold?, priceTolerancePct?, confidenceFloor?, expectedVersion, reason }.
 * Returns { values, expectedVersion, reason, problems }. Anything else is a problem.
 */
export function validatePolicyInput(body) {
  const problems = [];
  const values = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { values, problems: ['Send the settings as a JSON object.'] };
  const { expectedVersion, reason, ...rest } = body;
  for (const [key, value] of Object.entries(rest)) {
    const p = valueProblem(key, value);
    if (p) problems.push(p);
    else values[key] = byKey[key].type === 'switch' ? value : roundTo(value, byKey[key].step);
  }
  if (!Object.keys(rest).length) problems.push('Send at least one setting to change.');
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) problems.push('Send expectedVersion: the version of the settings you are changing.');
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why.length < 3) problems.push('Give a reason for the change.');
  return { values, expectedVersion, reason: why.slice(0, 500), problems };
}

const usable = (doc) => Object.fromEntries(KEYS.map((k) => [k, doc && !valueProblem(k, doc[k]) ? doc[k] : ENV_DEFAULTS[k]]));

let current = { ...ENV_DEFAULTS, version: 0, updatedBy: null, updatedAt: null };
let loadedAt = 0;

/** Lay a settings document's values over config.policy (the one policy object). */
function apply(doc) {
  const v = usable(doc);
  config.policy.matchThreshold = v.matchThreshold;
  config.policy.priceTolerancePct = v.priceTolerancePct;
  config.policy.minConfidence = Math.round(v.confidenceFloor) / 100; // whole percent: 90 -> 0.9
  config.policy.requireDeliverySlip = v.requireDeliverySlip;
  current = { ...v, version: doc?.version ?? 0, updatedBy: doc?.updatedBy?.id ? { id: doc.updatedBy.id, name: doc.updatedBy.name } : null, updatedAt: doc?.updatedAt ?? null };
  loadedAt = Date.now();
  return current;
}

/** The settings document, created with the environment's values the first time (race-safe). */
async function ensure() {
  return PolicySettings.findOneAndUpdate(
    { _id: POLICY_ID },
    { $setOnInsert: { ...ENV_DEFAULTS, version: 1, updatedBy: { id: 'system:defaults', name: 'Defaults (environment)' }, updatedAt: new Date() } },
    { upsert: true, new: true },
  ).lean();
}

export async function loadPolicy() {
  return apply(await ensure());
}

/** Re-read the settings if this instance's copy is older than REFRESH_MS. Never throws. */
export async function refreshPolicy({ now = Date.now(), log = console } = {}) {
  if (now - loadedAt < REFRESH_MS) return;
  try {
    await loadPolicy();
  } catch (err) {
    loadedAt = now; // try again after REFRESH_MS, not on every request
    log.error?.(`Could not load the policy settings; keeping the current values: ${err?.message}`);
  }
}

/** The values and version in force now, for an invoice run's snapshot. */
export const policySnapshot = () => ({
  matchThreshold: current.matchThreshold,
  priceTolerancePct: current.priceTolerancePct,
  confidenceFloor: current.confidenceFloor,
  requireDeliverySlip: current.requireDeliverySlip,
  version: current.version,
});

const view = () => ({
  fields: POLICY_FIELDS.map((f) => ({ ...f, value: current[f.key], default: ENV_DEFAULTS[f.key] })),
  version: current.version,
  updatedBy: current.updatedBy,
  updatedAt: current.updatedAt,
});

/** GET /api/settings/policy: any signed-in role. With the latest changes from the audit log. */
export async function getPolicySettings(actor) {
  requireActor(actor);
  await loadPolicy();
  const history = (await sampleLedger.listAudit({ subjectId: POLICY_ID, limit: 200 }))
    .filter((e) => e.subjectKind === 'settings')
    .slice(-10)
    .reverse()
    .map((e) => ({ at: e.at, actor: e.actor, from: e.from, to: e.to, reason: e.reason, detail: e.detail }));
  return { ...view(), history };
}

const shown = (key, value) => (byKey[key].type === 'switch' ? (value ? 'on' : 'off') : `${value}%`);

/**
 * PUT /api/settings/policy: an administrator saves new values from the version
 * they looked at. 400 for anything out of bounds (nothing saved), 409 when
 * someone else saved first. Audited with every old and new value and the reason.
 */
export async function savePolicySettings(body, actor) {
  requireActor(actor, 'admin');
  const { values, expectedVersion, reason, problems } = validatePolicyInput(body);
  if (problems.length) throw new HttpError(400, problems.join(' '));
  const before = await ensure();
  if (before.version !== expectedVersion) {
    throw new HttpError(409, `Someone else saved the settings first (now version ${before.version}). Reload them and try again.`, { version: before.version });
  }
  const changed = KEYS.filter((k) => k in values && values[k] !== before[k]);
  if (!changed.length) throw new HttpError(400, 'No value was changed.');
  const at = new Date();
  const saved = await PolicySettings.findOneAndUpdate(
    { _id: POLICY_ID, version: expectedVersion },
    { $set: { ...Object.fromEntries(changed.map((k) => [k, values[k]])), updatedBy: { id: String(actor.id), name: actor.name }, updatedAt: at }, $inc: { version: 1 } },
    { new: true },
  ).lean();
  if (!saved) {
    const now = await PolicySettings.findById(POLICY_ID).lean();
    throw new HttpError(409, `Someone else saved the settings first (now version ${now?.version}). Reload them and try again.`, { version: now?.version });
  }
  apply(saved);
  await recordAudit({
    subjectKind: 'settings',
    subjectId: POLICY_ID,
    actor: actor.name,
    actorId: actor.id,
    action: 'policy_changed',
    from: `v${before.version}`,
    to: `v${saved.version}`,
    reason,
    detail: changed.map((k) => `${byKey[k].label}: ${shown(k, before[k])} -> ${shown(k, saved[k])}`).join('; '),
  });
  return getPolicySettings(actor);
}
