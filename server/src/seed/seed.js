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
  InvoiceDocument,
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
  IngestionItem,
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

// The sample reference data, replaced by the samples on every reset (with any
// bank-detail proposals, whose suppliers are replaced too).
export const REFERENCE_MODELS = [Vendor, PurchaseOrder, GoodsReceipt, BeneficiaryChange];

// The demo data that Reset and Load demo month delete. Everything else is kept:
// users, sessions, settings, the simulated bank's test scenarios, the mailbox
// connections (IngestionSource) and the audit log. The record of imported email
// attachments goes with the invoices it points to.
export const DEMO_DATA_MODELS = [
  IngestionItem,
  Invoice,
  InvoiceDocument, // the original PDFs go with their invoices
  AgentRun,
  Payment,
  PaymentJob,
  VendorQuery,
  OutboxMessage,
  BankStatement,
  Report,
  SupplierHint,
  SimBankTransaction,
  SimBankAttempt,
  SimBankAccount,
];

const deleteAll = async (models) => Object.fromEntries(await Promise.all(models.map(async (m) => [m.modelName, (await m.deleteMany({})).deletedCount])));

/** Replaces the reference data with the samples. Returns how many records were removed, per collection. */
export async function seedReferenceData() {
  const removed = await deleteAll(REFERENCE_MODELS);
  await Vendor.insertMany(vendors.map(withBeneficiary));
  await PurchaseOrder.insertMany(purchaseOrders);
  await GoodsReceipt.insertMany(goodsReceipts);
  return removed;
}

export async function seedIfEmpty() {
  if ((await Vendor.countDocuments()) === 0) {
    await seedReferenceData();
    return true;
  }
  return false;
}

/**
 * Deletes the demo data and reloads the sample reference data. Users, sessions
 * and the audit log are kept. The simulated bank starts again from its opening
 * balance. Returns how many records were removed, per collection.
 *
 * Only call it through services/demoReset.js (which refuses Production), or
 * from `npm run seed` on a database you mean to wipe.
 */
export async function resetEverything() {
  const removed = await deleteAll(DEMO_DATA_MODELS);
  return { ...removed, ...(await seedReferenceData()) };
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
