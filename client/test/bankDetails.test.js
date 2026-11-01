// Bank details on screen: masked rows, the hidden text for reviewers, and the
// one-line "paid to" text on a payment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bankDetailRows, paidToText, HIDDEN_TEXT } from '../src/bankDetails.js';

test('masked details become rows; hidden details say so and show nothing else', () => {
  assert.deepEqual(bankDetailRows({ accountName: 'Harbour (SIMULATED)', bsb: '999-•••', accountNumber: '•••001', billerCode: '•••01', crn: '•••027', hidden: false }), [
    { label: 'Account name', value: 'Harbour (SIMULATED)' },
    { label: 'BSB and account', value: '999-••• •••001' },
    { label: 'BPAY', value: 'Biller •••01, ref •••027' },
  ]);
  assert.deepEqual(bankDetailRows({ hidden: true, methods: ['EFT'] }), [{ label: 'Bank details', value: HIDDEN_TEXT }]);
  assert.deepEqual(bankDetailRows(null), []);
});

test('a payment says where it goes, masked, or that it is hidden', () => {
  assert.equal(paidToText({ version: 2, accountName: 'Harbour', masked: { accountName: 'Harbour', bsb: '999-•••', accountNumber: '•••001' } }), 'Harbour BSB 999-••• •••001 (v2)');
  assert.equal(paidToText({ version: 1, masked: { accountName: 'Pallets', cardToken: 'SIMCARD-•••8342' } }), 'Pallets SIMCARD-•••8342 (v1)');
  assert.equal(paidToText({ version: 3, method: 'EFT', hidden: true }), 'Hidden for your role (v3)');
  assert.equal(paidToText(null), null);
});
