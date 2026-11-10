// Functions the orchestrator must never reach (docs/agentic-analysis.md §9.3),
// in any phase: no tool is named after them, and no tool implementation calls
// them. The orchestrator may only point a person to the screen that does these.
// test/orchestratorTools.test.js checks the list against the code:
//   - every entry still exists where it says (so the list cannot go stale);
//   - no orchestrator source file mentions any of these names;
//   - running every tool, as every role, calls none of the object methods
//     below, and changes no record.
//
// module: path under server/src. owner: the object the function is a method of
// (ingestion() is the mailbox ingestion service's shared instance).

const entry = (area, module, owner, ...names) => names.map((name) => Object.freeze({ area, module, owner, name }));

export const NEVER_EXPOSED = Object.freeze([
  // Sending email to suppliers (payment notices, the daily summary).
  ...entry('email', 'services/paymentSystem.js', 'paymentNotices', 'approveAndSend', 'discard'),
  ...entry('email', 'services/paymentSystem.js', 'emailDelivery', 'deliver'),
  // Queries to suppliers about an invoice's variance: drafted, edited and sent by a person only.
  ...entry('email', 'services/paymentSystem.js', 'supplierDisputes', 'draftDispute', 'editDispute', 'sendDispute', 'discardDispute', 'resolveDispute'),
  ...entry('email', 'services/dailySummary.js', null, 'createDailySummaryHandler'),
  // Supplier bank details: changes, approvals and the audited reveal.
  ...entry('bank_details', 'services/beneficiaries.js', null, 'proposeChange', 'approveChange', 'rejectChange', 'revealBankDetails'),
  // Users and roles.
  ...entry('users', 'services/users.js', null, 'createUser', 'updateUser', 'resetPassword', 'changeOwnPassword', 'createFirstAdmin'),
  // The agent's policy settings.
  ...entry('settings', 'services/policySettings.js', null, 'savePolicySettings'),
  // Payment execution and the simulated bank's controls.
  ...entry('payment_execution', 'services/paymentSystem.js', 'paymentExecutor', 'tick'),
  ...entry('payment_execution', 'services/paymentSystem.js', 'simBank', 'submitPayment', 'settle', 'setBalance', 'setScenario'),
  ...entry('payment_execution', 'services/paymentSystem.js', 'bankAdapter', 'submitPayment'),
  // Scheduler work and mailbox controls.
  ...entry('cron', 'services/ingestion.js', 'ingestion()', 'cronTick', 'sync', 'retry', 'startConnect', 'completeConnect', 'disconnect', 'setEnabled'),
  // Demo data: reset and reload.
  ...entry('demo_reset', 'seed/seed.js', null, 'resetEverything'),
  ...entry('demo_reset', 'services/demo.js', null, 'loadDemoMonth'),
  ...entry('demo_reset', 'services/demoReset.js', null, 'withDemoWipe', 'createDemoResetHandler'),
]);
