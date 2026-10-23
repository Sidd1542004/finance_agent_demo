# Finance Operations Agent

The first of the six agents on the Save Labour Cost landing page, as a working prototype.
It covers the Finance tasks the page lists, as four workflows:

| Workflow | What the agent does |
|---|---|
| Invoices | Reads a supplier invoice, validates the supplier and tax (ABN/GST for Australia, GSTIN/CGST/SGST/IGST for India), matches it to the purchase order and what was delivered, scores the match and looks for duplicates. It never approves or pays: a clean invoice goes to a person as eligible for approval, anything else goes with the reasons. People approve, schedule and record payments (simulated). |
| Supplier emails | Works out which invoices a supplier is asking about and replies with the status from the records, or hands the email to a person. |
| Bank reconciliation | Matches each payment on a bank statement to an approved invoice and marks it as paid. Flags double payments, unapproved payments and lines it cannot place. |
| Month-end report | Adds up the month, writes a short summary, and lists what is still open. |

Stack: MongoDB, Express, React (Vite), Node. AI steps use Groq.

Everything runs on made-up sample data. No accounting system, mailbox or real bank is
connected. No money moves: EFT, BPAY and Card payments go to a **simulated bank** inside
the app, and every payment, transaction and balance is labelled **simulated**. People
sign in with an email and password and act under their own account and roles.

**Accounts, payments and the simulated bank** (roles, statuses, the scheduler, the
simulated bank, supplier notices, environment variables and one-time setup) are
described in [docs/payments.md](docs/payments.md).

## Run it

You need Node 20 or newer and MongoDB (a local install or a free MongoDB Atlas cluster).

```
npm run setup
```

Copy `server/.env.example` to `server/.env`, then set:

- `MONGODB_URI` if your database is not on `mongodb://127.0.0.1:27017`
- `GROQ_API_KEY` with a key from https://console.groq.com/keys

Create the first administrator (the password is asked for at a hidden prompt):

```
npm run create-admin --prefix server -- --email you@example.com --name "Your Name"
```

```
npm run dev
```

Open http://localhost:5173 and sign in. Add the other users and their roles on the Admin
screen. The sample suppliers, purchase orders and deliveries load themselves the first
time the server starts. To run due payments locally, press **Run due payments now** on
the Payments screen (administrators), or call the tick:
`curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:4000/api/cron/tick`.

Other commands: `npm test` (the server tests; no network or keys needed. The tests that
need MongoDB start an in-memory server with `mongodb-memory-server`: it uses a local
`mongod` if one is on the PATH, otherwise it downloads one the first time; set
`MONGODB_TEST_URI` to use another server instead), `npm run format` / `npm run format:check` (Prettier). GitHub Actions (`.github/workflows/ci.yml`) runs the tests, the client build and the format check on every push and pull request., `npm run seed`
(wipe and reload the sample data), `npm run build` then `npm start` (serve the dashboard
and the API together on port 4000).

### Without a Groq key

If `GROQ_API_KEY` is empty the app still runs. Invoices are read by a basic pattern reader
that only understands the sample layout, supplier emails by a keyword reader, bank lines
get no AI notes, and the report summary uses standard wording. The top bar shows whether
AI is on.

## Deploy to Vercel

The dashboard and the API deploy together as **one** Vercel project: the dashboard as
static files from `client/dist`, the API as one serverless function (`api/index.js`, which
runs the same Express app as `npm start`). `vercel.json` holds the build settings.

1. **MongoDB Atlas.** In Network Access, allow `0.0.0.0/0`. Vercel functions have no fixed
   IP address, so a narrower list will refuse them. Keep the database user's password strong.
2. **Import the repository** in Vercel (Add New > Project). Leave the Root Directory as it
   is (the repository root) and set Framework Preset to **Other**. Do not override the build,
   output or install commands: they come from `vercel.json`.
3. **Environment variables** (Project Settings > Environment Variables):

   | Variable | |
   | --- | --- |
   | `MONGODB_URI` | Required. The Atlas connection string, including the database name. |
   | `GROQ_API_KEY` | Optional. Without it the app uses the basic readers. |
   | `GROQ_MODEL` | Optional. Defaults to `llama-3.3-70b-versatile`. |
   | `GROQ_VISION_MODEL` | Optional. Defaults to `qwen/qwen3.8-27b`. Reads scans and photos. |
   | `TIME_ZONE` | Optional. Defaults to `Australia/Sydney`. Report months, "today", due dates and overdue follow it (Vercel's clock is UTC). |
   | `DEMO_MODE` | `true` shows Load demo month and Reset (they wipe the data). Unset or anything else: off. |
   | `ACCESS_PASSWORD` | Recommended for a public demo. Every page and API call asks for it (any user name). |
   | `RATE_LIMIT_WINDOW_MINUTES`, `RATE_LIMIT_MAX` | Optional. Default: 30 requests that run the agent per 10 minutes per IP address. |
   | `COMPANY_NAME`, `ABR_GUID`, `SEGREGATE_DUTIES`, policy values | Optional, as in `server/.env.example`. |
   | `CRON_SECRET` | Required for payments: the scheduler calls `/api/cron/tick` with it (and the daily summary uses it). A long random string. |
   | `ADMIN_SETUP_TOKEN` | Optional, one-time: lets the first administrator be created from the sign-in page. Remove it afterwards. |
   | Payment, simulated bank and supplier email settings | Optional, see [docs/payments.md](docs/payments.md#environment-variables-new). `APP_ENV` stays unset (development) for a demo, so no supplier is ever emailed. |
   | `ALERT_EMAILS`, `APP_URL`, `CRON_SECRET`, `RESEND_API_KEY` or `SMTP_*`, `ALERT_FROM` | Optional: the daily summary email (below). |
   | `CORS_ORIGINS` | Leave unset: the dashboard and API are on the same site. |

   Do **not** set `PORT` (Vercel chooses it) or `DNS_SERVERS` (a Windows-only workaround).
   `VITE_API_BASE_URL` is not needed either: the dashboard calls `/api` on its own site.
4. **Deploy**, then open `https://<your-project>.vercel.app/api/health`. It should answer
   `"database": "connected"`. A 503 saying the database cannot be reached means
   `MONGODB_URI` is wrong or Atlas Network Access is refusing Vercel. The function log
   shows the reason, with the host only (never the user name or password).
5. **First administrator and upgrade.** From your machine, with `MONGODB_URI` set to the
   same database: `npm run migrate --prefix server`, then `npm run create-admin --prefix
   server -- --email you@example.com --name "Your Name"`. See
   [docs/payments.md](docs/payments.md#one-time-setup-existing-deployment).
6. **Payment scheduler.** Point an external scheduler at `GET /api/cron/tick` every 5
   minutes with `Authorization: Bearer <CRON_SECRET>` (Hobby allows only daily Vercel
   cron jobs; `vercel.json` adds a daily tick as a safety net only). Details and
   options in [docs/payments.md](docs/payments.md#how-often-and-the-vercel-plan).

Protecting a public demo:

- **Accounts.** Every API call except `/api/health`, sign-in and the cron endpoints needs a
  signed-in user, and the server checks the user's role for every action (see
  [docs/payments.md](docs/payments.md#accounts-and-roles)).
- **Shared password.** With `ACCESS_PASSWORD` set, the browser asks for a password (any user
  name) before showing anything. On Vercel, `middleware.js` checks it for the dashboard's
  static files; the Express app checks it for the API (and for everything when run locally).
  The password is compared in constant time. It is one shared password, not user accounts.
- **Vercel Deployment Protection** (Project Settings > Deployment Protection) can protect
  preview deployments, or every deployment, behind a Vercel login as well.
- **Demo buttons.** Load demo month and Reset only work when `DEMO_MODE=true`, and only for
  administrators; the server refuses them otherwise, whatever the dashboard shows. They
  keep users, sessions and the audit log.
- **Rate limits.** Requests that call Groq or process a file (adding or re-processing an
  invoice, supplier email or bank statement, a person's action that re-runs the agent,
  writing a report, loading the demo month) are limited per IP address: 30 per 10 minutes
  by default (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MINUTES`). The count is kept in memory,
  so **on Vercel each function instance counts separately**: treat it as a brake on runaway
  use, not an exact quota. Reading the dashboard is not limited.

Daily summary email (optional):

- Once a day the agent can email what needs a person: overdue invoices and those due in
  the next 7 days, new exceptions from the last 24 hours (Needs Review, On Hold, Payment
  Failed, could not process), supplier emails waiting for a reply, and bank lines needing a
  decision, each with a link to the dashboard (`APP_URL`). It names invoices, suppliers,
  amounts and dates only: never a key, a bank account number or a bank line's description.
- Set `ALERT_EMAILS` (comma-separated), `APP_URL`, `CRON_SECRET` (a long random string),
  and either `RESEND_API_KEY` (with `ALERT_FROM` on a domain verified in Resend) or
  `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`. Without an email
  service or recipients, nothing is sent.
- `vercel.json` schedules `GET /api/cron/daily-summary` at 03:00 UTC every day (1 or 2 pm
  in Sydney). Vercel sends `Authorization: Bearer <CRON_SECRET>` itself; any other caller
  without it gets 401. **The Vercel Hobby plan allows daily cron jobs only** (and may run
  them at any time within the hour).
- To check the email without sending it:
  `curl -H "Authorization: Bearer $CRON_SECRET" "https://<your-project>.vercel.app/api/cron/daily-summary?preview=1"`.

Limits to know:

- **Uploads are limited to 4 MB.** Vercel refuses request bodies over 4.5 MB before they
  reach the app.
- **Each request has 60 seconds** (`maxDuration` in `vercel.json`). Processing one invoice
  with Groq normally takes a few seconds; loading the demo month takes longer. When Groq
  is busy (429), briefly down (5xx), unreachable or slow, a call is tried up to twice more,
  waiting as long as Groq's `Retry-After` asks (at most 8 seconds); all attempts fit in
  45 seconds. A bad request or a rejected key is not retried.
- **Cold starts.** The first request after a quiet spell starts a new function instance and
  opens the database connection, so it can take a few seconds. Later requests reuse the
  connection.

To run it the way Vercel does, on one port: `npm run build --prefix client`, then
`node scripts/vercel-local.js` (port 3000). `node scripts/smoke.js <url>` runs the demo
month, a PDF upload, a bank statement and the month-end report against any deployment.
It resets the data, so only use it on a demo.

## Demo script

Sign in as an administrator and press **Load demo month** first. It wipes everything and
runs the seven sample invoices through the agent (one of them twice). Then, as people
would: Priya approves the clean invoice and the received quantity of the pallets invoice
($727.10 of $811.80), Sam schedules both payments by cheque (paid outside the system, so
the sample bank statement can match them), and Priya rejects the GST error. Priya and Sam
are internal demo actors, not accounts.

To see a bank payment: approve the large Bluegum invoice, try to schedule it by EFT (refused:
Bluegum has no verified bank details), propose details on the Suppliers screen and have a
second person approve them, schedule the EFT payment, then press **Run due payments now**
twice, about 20 seconds apart. The supplier emails
and the bank statement refer to those invoices.

**1. Invoices.** The counts at the top: in queue, matched by agent (cleared with no
exceptions), exceptions, awaiting payment. Open any invoice to see the six steps, the
summary, the match score and its breakdown, the checks, the invoice-against-PO table, the
actions you can take, the payment (if any) and the status history.

| Sample | Where the agent leaves it |
|---|---|
| Matches its purchase order | 100%, **Under Review**: eligible for approval. A person approves it. |
| Bills for more than was delivered | 12 pallets invoiced, 10 received. **On Hold**. Only "approve received quantity only" is allowed. |
| Price is higher than agreed | Chairs 8% above the PO price; score 83%. **On Hold**. |
| GST is calculated wrongly | GST shown is $70.00, should be $77.00. **On Hold**. |
| Correct, a large amount | 100%, **Under Review**. Large amounts are never approved automatically either. |
| Unknown supplier with an invalid ABN | ABN fails the checksum, supplier unknown, order does not exist. **Needs Review**. |
| No purchase order quoted | Nothing to match against. **Needs Review**. |
| The first one again | Possible duplicate. **Needs Review**; cannot be approved until a person clears it, and a second payment is refused anyway. |

**2. Supplier emails.** Process each sample.

| Sample | What happens |
|---|---|
| Asks when an approved invoice will be paid | Answered without a person, from the records. |
| Asks about two invoices, one under review | Answered. The reply says one is scheduled and one is held for a price difference. |
| Asks to change bank details | Never answered automatically. Goes to a person with no draft. |
| Comes from an address that is not on file | Goes to a person. No invoice details are shown or sent. |
| Disputes a late payment | Goes to a person, who writes the reply. |

**3. Bank reconciliation.** Reconcile the sample statement (also in `samples/` as a CSV).
Two payments match and are marked as paid. Three lines go to a person: a possible double
payment, a payment for an invoice nobody approved, and a bank fee. One line is money in
and is skipped.

**4. Month-end report.** Write the report for the current month. It compares the month
with the one before, says the month is not ready to close and lists what is open. Clear those items in the other tabs and write
it again.

## How it maps to the landing page

The page promises that every agent follows six steps. `server/src/agent/core/loop.js` is
that loop, and it knows nothing about finance. Each workflow is one file that fills in the
six steps:

| Step | Invoices | Supplier emails | Bank reconciliation | Month-end report |
|---|---|---|---|---|
| Receive | Take in the PDF or text | Take in the email | Take in the CSV | Take the month |
| Understand | Read the invoice fields | Work out the request and the invoices | Read the lines | Gather the month's records |
| Decide | Validation, PO match, score, duplicates | 7 checks | Match lines to payments | Calculate figures, check they agree |
| Act | Prepare for a person (never approves or pays) | Queue the reply or hold | Mark matched payments as paid | Write the summary |
| Verify | No payment exists for the invoice | Reply matches, then release it | Paid total equals matched lines | Every number is in the figures |
| Escalate | Held or failed invoices | Held or failed emails | Lines it could not place | Open items |

### Who approves invoices

People do. The agent never approves an invoice and never creates a payment, whatever the
score. **85% means eligible for approval review, not approval or payment.** See
"Invoice validation and PO matching" below for the score, the statuses and the actions.

### Design decisions worth knowing

- **AI reads and writes; fixed rules decide.** The model turns an invoice or an email into
  fields and writes the report summary. Every decision (approve, reply, match) is plain code
  in the `*Rules.js` files, so the same input always gets the same answer and each answer has
  a reason a finance person can check.
- **What the AI says is checked against the source.** An invoice number, ABN or total that
  is not in the invoice text, an invoice number that is not in the email, or a number in the
  report summary that is not in the figures, is caught. The invoice or email goes to a person;
  the summary is replaced with standard wording.
- **Replies to suppliers are templates filled from the records.** The model never writes to
  a supplier, so an email cannot talk it into saying something.
- **Bank details always go to a person.** Any email mentioning a BSB, an account or payment
  details is held by a fixed rule, whatever the AI reader thought the email was about.
- **A supplier only hears about their own invoices.** The sender must match the address on
  file, and the invoice must carry that supplier's ABN.
- **Bank matching uses no AI.** Lines are matched by invoice number, supplier name and exact
  amount. A line that fits on amount alone is only suggested. AI adds an optional note to
  lines a person has to look at, and nothing acts on it.
- **Failures escalate.** If any step throws (Groq is down, a file cannot be read), the
  remaining work is skipped, nothing is paid or sent, and the item is flagged.
- **The agent never approves, rejects or pays an invoice.** Missing information (for example no ABN) sends it to Needs Review, never to Rejected.
- **Part approvals follow through.** Approving the received quantity only approves the lower
  amount, the payment is scheduled for it, the bank match expects that amount, and a supplier who asks is told the invoice
  was approved for the quantity received.
- **Every screen has an audit trail** with the time and who acted: the agent, a fixed rule
  or a person.

## Invoice validation and PO matching

### What the agent checks

Mandatory checks (any failure stops the invoice, whatever the score):

| Check | Fails to |
|---|---|
| Required details (supplier, number, date, total, lines) | Needs Review |
| Reader confidence | Needs Review |
| Amounts add up (line totals, subtotal, subtotal + tax = total) | Needs Review, approval blocked |
| Tax rules identified (Australia or India, from the invoice itself) | Needs Review |
| Supplier tax number: ABN (checksum; ABR lookup if `ABR_GUID` is set, otherwise "unverified") or GSTIN (format and check character) | Needs Review (`MISSING_ABN_POLICY=hold` makes a missing ABN On Hold). Never Rejected. |
| GST registration (ABR or the supplier record; GSTIN for India) | Needs Review |
| Tax charged: 10% GST (Australia); CGST = SGST or IGST alone, at a standard rate (India) | On Hold |
| Supplier on the approved list | Needs Review |
| Not a duplicate (same supplier + invoice number; same supplier + total + date; same number + total; identical document) | Needs Review, approval blocked until cleared |
| Purchase order identified and raised with this supplier | Needs Review |
| Items and prices within tolerance of the PO | On Hold |
| Quantity within what was ordered, received and is still left on the PO after earlier invoices | On Hold; only the received quantity can be approved |
| Match score at or above the threshold | On Hold |

Australian rules are never applied to an Indian GST invoice, and the reverse. An ABN
that passes the checksum but has not been looked up is shown as **valid format,
unverified**, not as verified.

### Match score

Out of 100, configurable threshold (`MATCH_THRESHOLD`, default 85). Separate from the
mandatory checks: a high score never overrides a failed check.

| Part | Weight | How it is scored |
|---|---|---|
| Supplier | 20 | ABN matches the PO's supplier 100%; matched through the supplier record without an ABN 75%; name only 50% |
| Items | 20 | Share of invoice value on lines found on the PO (by item code, or description similarity ≥ 0.6) |
| Quantity | 20 | Share of invoice value on lines within ordered, received and remaining quantity |
| Price | 20 | Share of invoice value on lines within the price tolerance (`PRICE_TOLERANCE_PCT`) |
| Amounts | 10 | Half for the invoice's own sums adding up, half for the subtotal agreeing with PO prices |
| Tax | 10 | Correct 100%; could not be verified 50%; wrong 0% |

With no PO only the amounts and tax parts can score, so the score is low and a reviewer
links a PO. Suggestions (top 3, only POs sharing at least one item, provisional score
≥ 50%) are shown with an explanation and are never linked automatically.

### Statuses

`Received → Processing → Under Review | Needs Review | On Hold → Approved → Payment
Pending → (Payment Processing →) Payment Completed`, plus `Rejected`, `Cancelled`,
`Payment Failed` and `Could not process`. Payment Processing is for payments through the
simulated bank: accepted, not yet confirmed. The backend refuses any other move. The agent can only reach Under Review,
Needs Review, On Hold or Could not process.

| From | Allowed to |
|---|---|
| Under Review, Needs Review | Approved, Rejected, Cancelled, On Hold, Processing (re-check) |
| On Hold | Approved, Rejected, Cancelled, Processing |
| Could not process | Processing, Rejected, Cancelled |
| Approved | Payment Pending, Rejected (reversal), Cancelled |
| Payment Pending | Payment Processing (sent to the simulated bank), Payment Completed, Payment Failed, Approved (payment cancelled), Rejected (reversal), Cancelled |
| Payment Processing | Payment Completed (the bank confirmed it), Payment Failed. Nothing can cancel it. |
| Payment Failed | Payment Pending (retry), Cancelled |
| Payment Completed, Rejected, Cancelled | Final (a paid invoice can have a recovery opened) |

### People's actions

Every action is recorded under the signed-in person's account; some need a note. Approve (note required if there are
exceptions), approve received quantity only, reject, place on hold, request a corrected
invoice, link a PO, mark as not a duplicate, process again, schedule payment (method,
date, time for bank payments, optional reference), reschedule payment, cancel payment (the
invoice stays approved), record payment (Cheque and Other only; reference required; a part
payment keeps it Payment Pending), mark payment failed (Cheque and Other only), reverse approval (cancels a scheduled payment; the
original approval is kept), cancel, start and close a recovery for a paid invoice.

**Edit fields** (reviewer, note required; from Under Review, Needs Review, On Hold or Could
not process) corrects what the reader got wrong: supplier, ABN, GSTIN, invoice number,
dates, PO number, currency, subtotal, GST, total and the line items. Values are checked
(ISO dates, finite numbers, an 11-digit ABN) before anything changes. Each correction is
kept on the invoice (`corrections`: field, from, to, by, note, time) and laid over whatever
the reader reads every time the agent runs, so it survives processing again. A corrected
field counts as confirmed by a person, so the reading-confidence check says "corrected by
..." instead of failing on it; every other check (ABN checksum, sums, PO matching,
duplicates, approval blockers) runs on the corrected values. Correcting a field never
approves anything.

When the supplier is identified, the agent also keeps a short **hint** per supplier and
field (the label printed next to the value, and an example of the right format, never the
invoice itself) and gives it to the AI reader for that supplier's later invoices. A hint
never stands in for the invoice: every value must still appear in the invoice's text.

Every status change is written to the invoice's history with who, from, to, reason and
time, and to the **audit log** (`AuditEvent`): one entry per status change of an invoice,
payment, supplier email, bank line or report, with subject, actor, action, from, to, reason,
detail and time. The log is append only: the model refuses updates and deletes, no route
changes it, and Reset and Load demo month keep it (they add an entry saying so). Changes are compare-and-set on the status, and the payment collection has one
payment per invoice (unique index), so two people clicking at once cannot both succeed.

Roles come from user accounts (reviewer, approver, payer, administrator), checked on the
server for every action. `SEGREGATE_DUTIES=true` stops the account that approved an
invoice from also paying it. The earlier typed-name lists (`REVIEWERS`, `APPROVERS`,
`PAYERS`) are moved onto accounts once by `npm run migrate --prefix server`.

### API

| Route | What it does |
|---|---|
| `POST /api/invoices/:id/actions/:action` | Any action above. Body: `{ note, ...fields }` (a `decidedBy` is ignored: the signed-in user acts). 400 bad input, 401 not signed in, 403 role, 409 not allowed now or changed meanwhile. |
| `POST /api/auth/login`, `/logout`, `/setup`, `/password`; `GET /api/auth/me` | Sign-in. |
| `/api/admin/users...` | Users and roles (administrators). |
| `GET /api/suppliers`; `POST /api/suppliers/:abn/beneficiary-changes`; `POST /api/beneficiary-changes/:id/approve`, `/reject` | Supplier bank details (simulated), two people. |
| `GET /api/payments?status=`, `GET /api/payments/:id`, `GET /api/payment-calendar` | Payments by status, one payment with its jobs, bank transaction and notices; the scheduling rules. |
| `GET /api/payment-notices`; `POST /api/payments/:id/notices`; `POST /api/payment-notices/:id/send`, `/discard` | Payment notices to suppliers. |
| `/api/sim-bank/...`; `/api/admin/sim-bank...`; `POST /api/admin/run-due` | The simulated bank, its settings, and "Run due payments now". |
| `GET` or `POST /api/cron/tick` | The payment scheduler's tick; needs `Authorization: Bearer <CRON_SECRET>`. |
| `GET /api/invoices/:id` | Adds `actions` (what is allowed and why not), `linkablePos`, `paymentMethods`, `payment`. |
| `GET /api/payables` | Overdue and due-soon invoices and cash needed (approved due in 7/30 days, awaiting a decision due in 7 days; AUD only). |
| `POST /api/invoices/:id/approval` | Kept: `approve`, `approve_received`, `reject`. |
| `POST /api/invoices/:id/rerun` | Kept: re-checks through the `rerun` action. |
| `GET /api/health` | Adds `abr` and which roles are configured; `policy` now has `matchThreshold`, `missingAbn`, `segregateDuties`. |
| `GET /api/invoices`, `/api/queries`, `/api/statements`, `/api/reports` | One page at a time, newest first: `?before=<nextCursor>&limit=<n>` (default 50, at most 200). Answers `{ items, nextCursor }`; `nextCursor` is null on the last page. Invoices also take `?filter=waiting|pay` and return `counts` (tabs and KPIs) over every invoice. |
| `GET /api/audit?subjectId=<id>` | The append-only audit log for one invoice, payment, supplier email, report, or bank line (`<statement id>:<line number>`), oldest first. Without `subjectId`, the latest entries. |
| `GET /api/cron/daily-summary` | The daily summary email; needs `Authorization: Bearer <CRON_SECRET>`. `?preview=1` returns it without sending. |

`AUTO_APPROVE_LIMIT` is gone; the new settings are `MATCH_THRESHOLD`,
`MISSING_ABN_POLICY`, `ABR_GUID`, `REVIEWERS`, `APPROVERS`, `PAYERS`,
`SEGREGATE_DUTIES`.

## Adding the next agent

1. Write `server/src/agent/<name>/<workflow>Agent.js` exporting an object with a `name`
   and the six stage functions, the way the finance agents do.
2. Give it what it needs through its arguments (a reader, a rules module, an adapter for
   the system it works in), not through imports, so it stays testable.
3. Run it with `runAndRecord(agent, input, { kind, id })` from `server/src/services/runs.js`.
   The audit trail and failure handling come for free.

To connect real systems, write a file with the same functions as
`server/src/integrations/sampleLedger.js` and pass that in instead.

## What this prototype does not do

- **Accounts, not single sign-on.** Email and password accounts with roles; no Google or
  company sign-in, no multi-factor authentication, and no self-service password reset (an
  administrator sets a new one). Sign-in rate limits are counted per server instance.
- **A simulated bank only.** There is no adapter for a real bank. Bank payments pay the
  whole remaining amount (part payments are by Cheque or Other), in AUD only. The simulated
  balance is updated with two separate writes, so a crash at exactly the wrong moment can
  leave it off by one payment (an administrator can set it again).
- **No real systems.** Suppliers, orders, deliveries, the payment queue, the outbox and the
  bank statement are sample data in MongoDB.
- **No mailbox.** Emails are pasted in. A real connection must also check that the sender
  address was not forged (SPF, DKIM), which this prototype cannot do.
- **No bank feed.** Statements are CSV files with date, description and amount columns.
- **Scans and photos need the Groq key.** With `GROQ_API_KEY` set, a JPG or PNG (up to
  4 MB), or a PDF with no text layer (its first 2 pages, rendered with unpdf and
  `@napi-rs/canvas`), is read by a Groq vision model (`GROQ_VISION_MODEL`). The model
  returns a transcription and the fields; the fields are checked against that
  transcription, which is kept as the invoice text. Because the same model wrote both,
  every invoice read from an image gets the check "Read from an image: confirm the key
  fields" and always goes to Needs Review. Without a key, scans and photos are refused
  with a clear message, as before.
- **No follow-up for the unpaid remainder.** After a received-quantity-only approval, the
  rest of the invoice is not tracked or paid later. One bank line pays one invoice. Two
  invoices that each bill half an order are not added together.
- **Supplier payments only.** Money in, payroll, tax and fees are not reconciled.
- **The report is an accounts payable summary,** not a month-end close. There is no general
  ledger, accruals or journals behind it. Months follow `TIME_ZONE` (Australia/Sydney by default).
- **Policy values are placeholders.** The 85% threshold, score weights, 2% price tolerance
  and 80% confidence floor are sample numbers; agree them with the finance team.
- **Payments are simulated.** Scheduling, executing and recording a payment only writes
  records. No real bank or accounting system is touched.
- **Tax numbers are not looked up by default.** ABNs are checked against the ABR only when
  `ABR_GUID` is set (not tested live). GSTINs are never looked up online.
- **Cash figures are AUD only.** Invoices in other currencies are listed but not added.
- **Remaining PO quantity counts every live invoice,** including ones not yet approved, so
  two invoices for the same goods cannot both pass.

## What was and was not tested

Tested: the 286 automated tests (including the scenarios in `server/test/lifecycle.test.js`, the user's Australian invoice template PDF and an Indian GST invoice). The accounts, payments and simulated bank tests run on a real MongoDB server (8.0, through `mongodb-memory-server`): concurrent cron ticks, leases, duplicate submissions, retries, timeouts, and every bank scenario. The sign-in, Admin, Suppliers, Payments and invoice screens were driven in a headless browser end to end (first administrator, users, demo month, a blocked payment to an unverified supplier, a two-person bank-detail change, an EFT payment scheduled, submitted, confirmed, and its notice approved to the simulated outbox).

Not tested: any live call to Groq or the ABR (the request and response handling are tested
against a stand-in); the app deployed on Vercel, with Vercel Cron or an external scheduler;
MongoDB Atlas; real email delivery of payment notices (Resend or SMTP). Run the demo script
once with your key, your database and your scheduler before showing it to anyone.
