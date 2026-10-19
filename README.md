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

Everything runs on made-up sample data. No accounting system, mailbox or bank is
connected. No money moves and no email is sent: "paid" and "sent" are entries in sample
collections, and every payment record is labelled **simulated**.

## Run it

You need Node 20 or newer and MongoDB (a local install or a free MongoDB Atlas cluster).

```
npm run setup
```

Copy `server/.env.example` to `server/.env`, then set:

- `MONGODB_URI` if your database is not on `mongodb://127.0.0.1:27017`
- `GROQ_API_KEY` with a key from https://console.groq.com/keys

```
npm run dev
```

Open http://localhost:5173. The sample suppliers, purchase orders and deliveries load
themselves the first time the server starts.

Other commands: `npm test` (154 tests, no database or network needed), `npm run seed`
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
   | `DEMO_MODE` | `true` shows Load demo month and Reset. Set it to `false` for anything real. |
   | `COMPANY_NAME`, `ABR_GUID`, `REVIEWERS`, `APPROVERS`, `PAYERS`, policy values | Optional, as in `server/.env.example`. |
   | `CORS_ORIGINS` | Leave unset: the dashboard and API are on the same site. |

   Do **not** set `PORT` (Vercel chooses it) or `DNS_SERVERS` (a Windows-only workaround).
   `VITE_API_BASE_URL` is not needed either: the dashboard calls `/api` on its own site.
4. **Deploy**, then open `https://<your-project>.vercel.app/api/health`. It should answer
   `"database": "connected"`. A 503 saying the database cannot be reached means
   `MONGODB_URI` is wrong or Atlas Network Access is refusing Vercel. The function log
   shows the reason, with the host only (never the user name or password).

Limits to know:

- **Uploads are limited to 4 MB.** Vercel refuses request bodies over 4.5 MB before they
  reach the app.
- **Each request has 60 seconds** (`maxDuration` in `vercel.json`). Processing one invoice
  with Groq normally takes a few seconds; loading the demo month takes longer.
- **Cold starts.** The first request after a quiet spell starts a new function instance and
  opens the database connection, so it can take a few seconds. Later requests reuse the
  connection.

To run it the way Vercel does, on one port: `npm run build --prefix client`, then
`node scripts/vercel-local.js` (port 3000). `node scripts/smoke.js <url>` runs the demo
month, a PDF upload, a bank statement and the month-end report against any deployment.
It resets the data, so only use it on a demo.

## Demo script

Press **Load demo month** first. It wipes everything and runs the seven sample invoices
through the agent (one of them twice). Then, as people would: Priya approves the clean
invoice and the received quantity of the pallets invoice ($727.10 of $811.80), Sam
schedules both payments (simulated), and Priya rejects the GST error. The supplier emails
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
Pending → Payment Completed`, plus `Rejected`, `Cancelled`, `Payment Failed` and `Could
not process`. The backend refuses any other move. The agent can only reach Under Review,
Needs Review, On Hold or Could not process.

| From | Allowed to |
|---|---|
| Under Review, Needs Review | Approved, Rejected, Cancelled, On Hold, Processing (re-check) |
| On Hold | Approved, Rejected, Cancelled, Processing |
| Could not process | Processing, Rejected, Cancelled |
| Approved | Payment Pending, Rejected (reversal), Cancelled |
| Payment Pending | Payment Completed, Payment Failed, Rejected (reversal), Cancelled |
| Payment Failed | Payment Pending (retry), Cancelled |
| Payment Completed, Rejected, Cancelled | Final (a paid invoice can have a recovery opened) |

### People's actions

Every action needs a name; some need a note. Approve (note required if there are
exceptions), approve received quantity only, reject, place on hold, request a corrected
invoice, link a PO, mark as not a duplicate, process again, schedule payment (method,
date, optional reference), record payment (reference required; a part payment keeps it
Payment Pending), mark payment failed, reverse approval (cancels a scheduled payment; the
original approval is kept), cancel, start and close a recovery for a paid invoice.

Every status change is written to the invoice's history with who, from, to, reason and
time. Changes are compare-and-set on the status, and the payment collection has one
payment per invoice (unique index), so two people clicking at once cannot both succeed.

Optional controls in `server/.env`: `REVIEWERS`, `APPROVERS`, `PAYERS` (comma-separated
names; empty means anyone) and `SEGREGATE_DUTIES=true` (whoever approved cannot pay).
Names are typed, not logged in, so these are guard rails, not security.

### API

| Route | What it does |
|---|---|
| `POST /api/invoices/:id/actions/:action` | Any action above. Body: `{ decidedBy, note, ...fields }`. 400 bad input, 403 role, 409 not allowed now or changed meanwhile. |
| `GET /api/invoices/:id` | Adds `actions` (what is allowed and why not), `linkablePos`, `paymentMethods`, `payment`. |
| `GET /api/payables` | Overdue and due-soon invoices and cash needed (approved due in 7/30 days, awaiting a decision due in 7 days; AUD only). |
| `POST /api/invoices/:id/approval` | Kept: `approve`, `approve_received`, `reject`. |
| `POST /api/invoices/:id/rerun` | Kept: re-checks through the `rerun` action. |
| `GET /api/health` | Adds `abr` and which roles are configured; `policy` now has `matchThreshold`, `missingAbn`, `segregateDuties`. |

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

- **No login.** Anyone who can open the page can approve invoices, schedule payments, send replies and confirm
  bank matches. The "Your name" fields are typed, not verified. Add authentication and roles
  before any real data goes in.
- **No real systems.** Suppliers, orders, deliveries, the payment queue, the outbox and the
  bank statement are sample data in MongoDB.
- **No mailbox.** Emails are pasted in. A real connection must also check that the sender
  address was not forged (SPF, DKIM), which this prototype cannot do.
- **No bank feed.** Statements are CSV files with date, description and amount columns.
- **No scanned invoices.** PDFs must contain text. Scans and photos need OCR.
- **No follow-up for the unpaid remainder.** After a received-quantity-only approval, the
  rest of the invoice is not tracked or paid later. One bank line pays one invoice. Two
  invoices that each bill half an order are not added together.
- **Supplier payments only.** Money in, payroll, tax and fees are not reconciled.
- **The report is an accounts payable summary,** not a month-end close. There is no general
  ledger, accruals or journals behind it. Months follow the server's time zone.
- **Policy values are placeholders.** The 85% threshold, score weights, 2% price tolerance
  and 80% confidence floor are sample numbers; agree them with the finance team.
- **Payments are simulated.** Scheduling and recording a payment only writes records. No
  bank or accounting system is touched.
- **Tax numbers are not looked up by default.** ABNs are checked against the ABR only when
  `ABR_GUID` is set (not tested live). GSTINs are never looked up online.
- **Cash figures are AUD only.** Invoices in other currencies are listed but not added.
- **Remaining PO quantity counts every live invoice,** including ones not yet approved, so
  two invoices for the same goods cannot both pass.

## What was and was not tested

Tested: the 106 automated tests (including the scenarios in `server/test/lifecycle.test.js`, the user's Australian invoice template PDF and an Indian GST invoice); every API route and all four screens, run end to end
without a Groq key against FerretDB (a MongoDB-compatible database), including the sample
PDFs and the sample CSV.

Not tested: any live call to Groq or the ABR, (no key was available when this was built; the request
and response handling are tested against a stand-in), and a real MongoDB server. Run the
demo script once with your key and your database before showing it to anyone.
