// The Admin screen's policy sliders: display conversions and the checks the
// form makes before saving. The limits are the server's (GET /api/admin/policy).

import test from 'node:test';
import assert from 'node:assert/strict';
import { toDisplay, fromDisplay, displayRange, formatValue, valueProblem, changedValues, checkedAtText, isSwitch } from '../src/policyForm.js';

const match = { key: 'matchThreshold', label: 'Match score', min: 50, max: 100, step: 1, format: 'percent', value: 99, default: 99 };
const confidence = { key: 'minConfidence', label: 'Reading confidence', min: 0.5, max: 1, step: 0.01, format: 'fraction', value: 0.99, default: 0.99 };
const price = { key: 'priceTolerancePct', label: 'Price tolerance', min: 0, max: 10, step: 0.5, format: 'percent', value: 2, default: 2 };

test('fractions are shown as percentages and stored as fractions, without float noise', () => {
  assert.equal(toDisplay(confidence, 0.99), 99);
  assert.equal(toDisplay(confidence, 0.57), 57);
  assert.equal(fromDisplay(confidence, '99'), 0.99);
  assert.equal(fromDisplay(confidence, '57'), 0.57);
  assert.equal(toDisplay(match, 99), 99);
  assert.equal(fromDisplay(price, '2.5'), 2.5);
  assert.deepEqual(displayRange(confidence), { min: 50, max: 100, step: 1 });
  assert.deepEqual(displayRange(price), { min: 0, max: 10, step: 0.5 });
  assert.equal(formatValue(confidence, 0.8), '80%');
  assert.equal(formatValue(match, 99), '99%');
});

test('every slider position round-trips to the same stored value', () => {
  for (const s of [match, confidence, price]) {
    const r = displayRange(s);
    for (let shown = r.min; shown <= r.max + 1e-9; shown += r.step) {
      const stored = fromDisplay(s, String(shown));
      assert.ok(stored >= s.min && stored <= s.max, `${s.key} ${shown}`);
      assert.equal(valueProblem(s, stored), null, `${s.key} ${shown}`);
    }
  }
});

test('values outside the limits, or not numbers, are refused before saving', () => {
  assert.match(valueProblem(match, 49), /between 50% and 100%/);
  assert.match(valueProblem(match, 101), /between/);
  assert.match(valueProblem(confidence, 1.2), /between 50% and 100%/);
  assert.match(valueProblem(price, -0.5), /between 0% and 10%/);
  assert.match(valueProblem(match, Number.NaN), /must be a number/);
  assert.match(valueProblem(match, undefined), /must be a number/);
  assert.equal(valueProblem(match, 50), null);
  assert.equal(valueProblem(match, 100), null);
});

test('only the settings that were moved are sent', () => {
  const settings = [match, confidence, price];
  assert.deepEqual(changedValues(settings, { matchThreshold: 99, minConfidence: 0.99, priceTolerancePct: 2 }), {});
  assert.deepEqual(changedValues(settings, { matchThreshold: 90, minConfidence: 0.99, priceTolerancePct: 2.5 }), { matchThreshold: 90, priceTolerancePct: 2.5 });
});

test('an invoice run says which policy it was checked against', () => {
  assert.equal(checkedAtText({ matchThreshold: 99, priceTolerancePct: 2, confidenceFloor: 99, version: 3 }), 'Checked at 99% match threshold (policy v3)');
  assert.equal(checkedAtText({ matchThreshold: 95 }), 'Checked at 95% match threshold');
  assert.equal(checkedAtText(null), null, 'runs from before snapshots were kept');
});

test('the delivery-slip switch: shown as On or Off, only true or false accepted, sent only when flipped', () => {
  const slip = { key: 'requireDeliverySlip', type: 'switch', label: 'Require delivery slip for goods', value: true, default: true };
  assert.equal(isSwitch(slip), true);
  assert.equal(isSwitch(match), false);
  assert.equal(formatValue(slip, true), 'On');
  assert.equal(formatValue(slip, false), 'Off');
  assert.equal(valueProblem(slip, false), null);
  assert.equal(valueProblem(slip, 'off'), 'Require delivery slip for goods must be on or off.');
  assert.deepEqual(changedValues([match, slip], { matchThreshold: 99, requireDeliverySlip: true }), {});
  assert.deepEqual(changedValues([match, slip], { matchThreshold: 99, requireDeliverySlip: false }), { requireDeliverySlip: false });
});
