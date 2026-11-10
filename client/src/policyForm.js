// The Admin screen's policy sliders and switches, as plain functions (no React), so they
// can be tested with node --test. The limits, steps and defaults come from
// the server (GET /api/admin/policy); nothing here repeats them. The server
// checks every value again when it is saved.

const decimals = (step) => (String(step).split('.')[1] || '').length;
const round = (n, places) => Number(n.toFixed(places));
const isFraction = (setting) => setting.format === 'fraction';
/** An on/off setting (type 'switch', e.g. requireDeliverySlip) rather than a slider. */
export const isSwitch = (setting) => setting.type === 'switch';

/** A stored value as shown on the slider: fractions as percentages (0.99 -> 99). */
export function toDisplay(setting, value) {
  return isFraction(setting) ? round(value * 100, Math.max(0, decimals(setting.step) - 2)) : value;
}

/** A slider position back to the stored value (99 -> 0.99). */
export function fromDisplay(setting, shown) {
  const n = Number(shown);
  return isFraction(setting) ? round(n / 100, decimals(setting.step)) : round(n, decimals(setting.step));
}

/** The slider's min, max and step, in the units it shows. */
export function displayRange(setting) {
  return { min: toDisplay(setting, setting.min), max: toDisplay(setting, setting.max), step: isFraction(setting) ? round(setting.step * 100, 4) : setting.step };
}

export const formatValue = (setting, value) => (isSwitch(setting) ? (value ? 'On' : 'Off') : `${toDisplay(setting, value)}%`);

/** Why a value would be refused, or null. The same limits the server applies. */
export function valueProblem(setting, value) {
  if (isSwitch(setting)) return typeof value === 'boolean' ? null : `${setting.label} must be on or off.`;
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${setting.label} must be a number.`;
  if (value < setting.min || value > setting.max) return `${setting.label} must be between ${formatValue(setting, setting.min)} and ${formatValue(setting, setting.max)}.`;
  return null;
}

/** { key: value } for the settings the person moved away from their current value. */
export function changedValues(settings, draft) {
  const out = {};
  for (const s of settings) if (Object.hasOwn(draft, s.key) && draft[s.key] !== s.value) out[s.key] = draft[s.key];
  return out;
}

/** The policy an invoice run was checked against, in words: "Checked at 99% match threshold (policy v3)". */
export function checkedAtText(snapshot) {
  if (!snapshot || typeof snapshot.matchThreshold !== 'number') return null;
  return `Checked at ${snapshot.matchThreshold}% match threshold${snapshot.version ? ` (policy v${snapshot.version})` : ''}`;
}
