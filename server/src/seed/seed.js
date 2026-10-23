// Loads the sample suppliers, purchase orders and goods receipts.
// Run with `npm run seed` (wipes everything), or let the server do it on first start.

import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { safeUri, redactSecrets } from '../safeUri.js';
import {
  Vendor,
  PurchaseOrder,
  GoodsReceipt,
  Invoice,
  AgentRun,
  Payment,
  PaymentJob,
  VendorQuery,
  OutboxMessage,
  BankStatement,
  Report,
  SupplierHint,
  BeneficiaryChange,
  SimBankTransaction,
  SimBankAttempt,
  SimBankAccount,
} from '../models/index.js';
import { vendors, purchaseOrders, goodsReceipts, sampleBeneficiaries } from './data.js';

// The sample suppliers' simulated bank details, as verified version 1.
const withBeneficiary = (v) =>
  sampleBeneficiaries[v.abn]
    ? {
        ...v,
        beneficiary: {
          ...sampleBeneficiaries[v.abn],
          simulated: true,
          status: 'verified',
          version: 1,
          changeId: null,
          proposedBy: 'Sample data',
          verifiedBy: 'Sample data (simulated)',
          verifiedAt: new Date().toISOString(),
        },
      }
    : v;

export async function seedReferenceData() {
  await Promise.all([Vendor.deleteMany({}), PurchaseOrder.deleteMany({}), GoodsReceipt.deleteMany({}), BeneficiaryChange.deleteMany({})]);
  await Vendor.insertMany(vendors.map(withBeneficiary));
  await PurchaseOrder.insertMany(purchaseOrders);
  await GoodsReceipt.insertMany(goodsReceipts);
}

export async function seedIfEmpty() {
  if ((await Vendor.countDocuments()) === 0) {
    await seedReferenceData();
    return true;
  }
  return false;
}

export async function resetEverything() {
  // Users, sessions and the audit log are kept. The simulated bank starts again from its opening balance.
  await Promise.all(
    [Invoice, AgentRun, Payment, PaymentJob, VendorQuery, OutboxMessage, BankStatement, Report, SupplierHint, SimBankTransaction, SimBankAttempt, SimBankAccount].map((m) =>
      m.deleteMany({}),
    ),
  );
  await seedReferenceData();
}

// Run directly: node src/seed/seed.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  } catch (err) {
    console.error(`Could not connect to MongoDB at ${safeUri(config.mongoUri)}: ${redactSecrets(err?.message)}`);
    process.exit(1);
  }
  await resetEverything();
  console.log(
    `Sample data loaded: ${vendors.length} suppliers, ${purchaseOrders.length} purchase orders, ${goodsReceipts.length} goods receipts. Invoices, supplier emails, bank statements and reports cleared.`,
  );
  await mongoose.disconnect();
}
