// One-time upgrade of an existing database for accounts and bank payments.
// Safe to run more than once.
//
//   npm run migrate --prefix server              (uses MONGODB_URI)
//   npm run migrate --prefix server -- --dry-run (shows what it would do)
//
// 1. Outbox: replaces the old unique index on queryId with a partial one,
//    so payment notices (which have no queryId) can be stored.
// 2. Builds the new indexes (users, sessions, payment jobs, bank-detail
//    changes, simulated bank).
// 3. Marks existing payments as manual (recorded by hand), schedule version 1.
// 4. Moves the old typed-name role lists (REVIEWERS, APPROVERS, PAYERS) onto
//    user accounts: a user whose name or email matches gets that role.
//    Names with no account are listed; create them, then run this again.
//    SEGREGATE_DUTIES keeps working as before, comparing accounts.
//
// Earlier typed names on invoices (decidedBy) stay as historical text.

import mongoose from 'mongoose';
import { parseArgs } from 'node:util';
import { config } from '../config.js';
import { safeUri, redactSecrets } from '../safeUri.js';
import { ensureOutboxIndexes, User, Payment, AuditEvent } from '../models/index.js';
import { auditEntry } from '../agent/finance/audit.js';

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const dry = values['dry-run'];
const say = (s) => console.log(`${dry ? '[dry run] ' : ''}${s}`);

try {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
} catch (err) {
  console.error(`Could not connect to MongoDB at ${safeUri(config.mongoUri)}: ${redactSecrets(err?.message)}`);
  process.exit(1);
}

try {
  // 1 and 2
  if (dry) say('Would update the outbox indexes and build the new indexes.');
  else {
    const dropped = await ensureOutboxIndexes();
    say(dropped.length ? `Outbox: replaced ${dropped.join(', ')} with a partial unique index.` : 'Outbox indexes already up to date.');
    for (const name of mongoose.modelNames()) await mongoose.model(name).init();
    say('Indexes built.');
  }

  // 3
  const old = await Payment.countDocuments({ route: { $exists: false } });
  if (old) {
    if (!dry) await Payment.updateMany({ route: { $exists: false } }, { $set: { route: 'manual' } });
    if (!dry) await Payment.updateMany({ scheduleVersion: { $exists: false } }, { $set: { scheduleVersion: 1 } });
  }
  say(`${old} existing payment(s) marked as manual.`);

  // 4
  const lists = { reviewer: config.roles.reviewers, approver: config.roles.approvers, payer: config.roles.payers };
  const users = await User.find().lean();
  const unmatched = [];
  for (const [role, names] of Object.entries(lists)) {
    for (const name of names) {
      const key = name.trim().toLowerCase();
      const user = users.find((u) => u.name.toLowerCase() === key || u.email === key);
      if (!user) {
        unmatched.push(`${name} (${role})`);
        continue;
      }
      if (user.roles.includes(role)) continue;
      if (!dry) {
        await User.updateOne({ _id: user._id }, { $addToSet: { roles: role } });
        await AuditEvent.create(
          auditEntry({ subjectKind: 'user', subjectId: user._id, actor: 'Migration', action: 'role_added', to: role, detail: `From the ${role.toUpperCase()}S list.` }),
        );
      }
      say(`${user.name} <${user.email}>: added the ${role} role.`);
    }
  }
  if (!Object.values(lists).some((l) => l.length)) say('No REVIEWERS / APPROVERS / PAYERS lists are set: nothing to move.');
  if (unmatched.length) say(`No account for: ${unmatched.join(', ')}. Create them (Admin > Users), then run this again.`);
  say(`SEGREGATE_DUTIES is ${config.policy.segregateDuties ? 'on' : 'off'}; it now compares accounts, not typed names.`);
  if (!dry) {
    await AuditEvent.create(auditEntry({ subjectKind: 'system', subjectId: 'migration', actor: 'Migration', action: 'migrated', detail: 'Accounts and bank payments upgrade.' }));
  }
  say('Done.');
} catch (err) {
  console.error(redactSecrets(err?.message || String(err)));
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
