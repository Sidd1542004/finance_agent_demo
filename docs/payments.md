# Accounts, payments and the simulated bank

Phase 1 adds sign-in with roles, supplier bank details changed by two people,
payments executed through a **simulated** bank by a scheduled tick, and payment
notices to suppliers. No real bank is ever contacted and no money moves.

## Accounts and roles

Everyone signs in with an email and password. Passwords are hashed with scrypt;
the session is a random token in an http-only cookie (`SameSite=Lax`, `Secure`
on HTTPS) and MongoDB stores only its SHA-256, with an expiry. Every request
that changes something must carry the dashboard's `X-FOA-Request` header and
come from the same site (CSRF protection). Repeated failed sign-ins lock the
account for a while; sign-ins are also rate-limited per IP address.

| Role | Can |
| --- | --- |
| Reviewer | Add and correct invoices, hold them, handle supplier emails, approve payment notices |
| Approver | Approve, reject, reverse, cancel and reopen invoices; approve or reject bank-detail changes |
| Payer | Schedule, reschedule, cancel and record payments; propose bank-detail changes; reconcile the bank; approve payment notices |
| Administrator | Users and roles, the simulated bank's settings, "Run due payments now", Load demo month and Reset; and everything the other three roles can do |

An administrator also holds the reviewer, approver and payer roles
(`server/src/auth/roles.js`), so they can work in every module. Every other
control still applies to them: with `SEGREGATE_DUTIES=true` the person who
approved an invoice cannot schedule, record or reconcile its payment;
bank-detail changes need a different person to approve them; status checks,
notes and payment idempotency are unchanged; and every action is recorded under
the administrator's own account. An account with no role, or only unknown roles,
sees nothing. The server checks roles on every request; the dashboard only hides
what you cannot do. The name typed in a request body is ignored: decisions are recorded under
the signed-in account (name and id). `ACCESS_PASSWORD` still works as an
optional outer gate in front of everything.

## Statuses

Invoice statuses keep their names. One is new: `payment_processing`.

| From | To | Who |
| --- | --- | --- |
| `approved` | `payment_pending` | Payer schedules a payment |
| `payment_pending` | `payment_processing` | The tick: the simulated bank accepted the instruction |
| `payment_pending` | `approved` | Payer cancels the scheduled payment (new) |
| `payment_processing` | `payment_completed` | The bank confirmed SUCCESS (only this; never a scheduled job, an HTTP 200 or a matching amount) |
| `payment_processing` | `payment_failed` | The bank FAILED or REJECTED it |
| `payment_pending` | `payment_failed` | Not sent: the bank details changed, or the bank refused it at submission |
| `payment_pending` | `payment_completed` | Cheque or Other recorded by hand, or matched to a bank statement line |
| `payment_failed` | `payment_pending` | Payer retries (a new schedule version and idempotency key) |

While `payment_processing`, nothing can cancel, reverse, reopen or reschedule
the payment: it completes or fails. A completed payment that should not have
been made goes through the existing recovery flow. All other transitions are as
before (see `server/src/agent/finance/lifecycle.js`).

Payment records keep their statuses: `queued` (scheduled), `processing` (new),
`paid` (completed), `failed`, `cancelled`, `on_hold`. The simulated bank's own
`PROCESSING / SUCCESS / FAILED / REJECTED` exist only in its collections.

Execution jobs: `pending → running → done | failed`, or back to `pending` to
retry or wait; `cancelled` or `superseded` when the payment is cancelled or
rescheduled. At most one active job per payment (unique index).

## Payment methods

| Method | How it is paid |
| --- | --- |
| EFT, BPAY, Card | Through the simulated bank at the scheduled time; confirmed only by the bank. Record payment is refused. |
| Cheque, Other | Outside the system; recorded with Record payment (part payments allowed), or matched from a bank statement, as before. |

A bank payment needs:

- the supplier's **verified** bank details, with no change waiting for approval,
  supporting the method (EFT: BSB and account; BPAY: biller code and CRN; Card:
  a simulated card token);
- the **full remaining amount**: the approved amount minus payments already
  confirmed. More is refused; less is refused too (record part payments by
  Cheque or Other);
- AUD;
- a **business day** (`BUSINESS_DAYS`, not a `BANK_HOLIDAYS` date) at or before
  the **cut-off** (`PAYMENT_CUTOFF`, in `TIME_ZONE`). A date or time that breaks
  a rule is refused with the next valid date and time; nothing is moved silently.

Rescheduling bumps the payment's schedule version and supersedes its job. A job
only runs for the version it was made for, so an old job can never pay. Cancel
payment, Reverse approval, Cancel invoice and Reopen also cancel the job.

At execution the tick checks everything again: the invoice still waits for
payment, the amount, and that the bank details are still the verified version
the payment was scheduled against. If not, the payment fails with the reason
and nothing is sent. A job that comes due on a weekend, a holiday or after the
cut-off (for example after a scheduler outage) waits for the next business
morning (`PAYMENT_DEFAULT_TIME`).

## Supplier bank details

Only simulated details are accepted (BSB starting `SIM_BANK_BSB_PREFIX`, default
999). A payer or administrator proposes details with a note saying where they
came from; a **different** approver or administrator approves or rejects them.
The proposer can withdraw. While a change is pending, payments to that supplier
are blocked. Nothing changes bank details automatically: the supplier email
agent still holds every email that mentions bank details for a person, and no
code path from an email or the AI reader creates a proposal. Every step is in
the audit log (subject `supplier`, masked details only), and the proposals are
kept as the history.

The sample suppliers Harbour (EFT, BPAY) and Southern Cross Pallets (EFT,
Card) are loaded with verified simulated details; Bluegum has none, to show the
block.

## The scheduler: `/api/cron/tick`

There is no always-running worker and no in-memory timer. `GET` or `POST
/api/cron/tick` with `Authorization: Bearer <CRON_SECRET>` does one bounded
round of work and returns counts (no secrets, no bank details):

1. The simulated bank settles transactions whose `completesAt` has passed.
2. Payments the bank is processing are checked: SUCCESS completes the payment
   and the invoice (recording the transaction reference and confirmation time)
   and drafts the supplier's confirmation; FAILED fails them.
3. Due jobs are claimed one at a time with an atomic compare-and-set and a lease
   (`JOB_LEASE_SECONDS`). A job whose tick died is taken over when its lease
   expires. At most `TICK_MAX_JOBS` per tick, within `TICK_BUDGET_SECONDS`.

It is safe to run concurrently and to retry: the payment is claimed by status
and schedule version; the bank instruction's idempotency key is fixed per
payment and version (`foa:<paymentId>:v<version>`), so a resubmission after a
crash or timeout returns the same transaction; after a timeout the bank is asked
by that key before anything is sent again. A temporary failure is retried with
back-off (1, 5, 15, 30 minutes); after `JOB_MAX_ATTEMPTS` the payment fails
only if the bank confirms it never received it.

Administrators can press **Run due payments now** (Payments screen), which runs
the same tick.

### How often, and the Vercel plan

The tick should run **every 5 minutes**. The repository cannot tell which
Vercel plan the project is on; the README assumes Hobby.

- **Vercel Hobby** runs cron jobs **once a day** at most (and at any time within
  the hour). `vercel.json` schedules the tick daily at 22:00 UTC (morning in
  Australia, before the cut-off) only as a safety net.
- **Use an external scheduler** for the 5-minute tick. For example
  [cron-job.org](https://cron-job.org) (free): create a job for
  `https://<your-project>.vercel.app/api/cron/tick`, every 5 minutes, method
  GET, with a request header `Authorization: Bearer <CRON_SECRET>`, timeout 60
  seconds. Any scheduler that can send that header works (Upstash QStash, a
  server's crontab with `curl`, and so on).
- `.github/workflows/payment-tick.yml` can call it from GitHub Actions every 5
  minutes once the repository secrets `PAYMENT_TICK_URL` and `CRON_SECRET` are
  set. GitHub's schedules are best-effort (often late, sometimes skipped), so
  use it as a backup only.
- **Vercel Pro** supports per-minute cron: change the tick's schedule in
  `vercel.json` to `*/5 * * * *` instead of using an external scheduler.

`CRON_SECRET` is the same secret as the daily summary's. It is only read on the
server and never sent to the browser. `ACCESS_PASSWORD` and the Vercel
middleware leave `/api/cron/*` open so the scheduler can reach it; the secret
protects it.

## The simulated bank

It runs inside the same Express app (`server/src/bank/simBank.js`) behind an
adapter (`server/src/bank/adapter.js`); the payment workflow only talks to the
adapter. Its routes, under `/api/sim-bank` (signed in, payer/approver/admin to
read, admin to change): the account and balance, transactions and their
history, a CSV statement of settled payments, and a direct submission endpoint
for testing (admin, `Idempotency-Key` header). Every record is labelled
simulated.

An accepted payment is stored as PROCESSING with a `completesAt` time
(`SIM_BANK_DELAY_SECONDS`, default 20 in demo mode) and completed by a later
tick. The balance starts at `SIM_BANK_OPENING_BALANCE`; an accepted payment
reserves its amount atomically and a confirmed one reduces the balance, so a
payment for more than the available balance is rejected as insufficient funds.

Test scenarios are set per supplier by an administrator (Admin screen), never
chosen at random: success, delayed completion, accepted then failed,
rejection, invalid beneficiary, unsupported method, temporary failure (the first
attempt is refused, the retry accepted). Duplicate submissions with the same
idempotency key return the original transaction; a different payment under the
same key is refused.

## Payment notices to suppliers

When the bank confirms a payment, a **draft** "Payment made" notice is written
from the records (invoice, amount, masked account, transaction reference,
confirmation date), never by the AI model. "Payment in progress" and "Payment
not completed" notices are drafted only when a person asks, and say so plainly.
A success notice is never written for a payment that is processing or failed.
There is one notice per payment, kind and transaction (unique key), however many
ticks run. A reviewer or payer approves each draft before it is delivered.

Delivery is decided only by server settings:

| `APP_ENV` | `SUPPLIER_EMAIL_MODE` | Email service | Goes to |
| --- | --- | --- | --- |
| `production` | `live` | Resend or SMTP | the supplier |
| anything else, or `outbox` | | Resend or SMTP, and `TEST_EMAIL_RECIPIENT` set | the test recipient, marked as a test |
| otherwise | | | nowhere: kept in the simulated outbox |

No request body or dashboard setting can change this.

## Bank reconciliation

A statement line quoting a simulated bank transaction reference (`SIMTXN-...`)
is matched to that payment as **confirmed by the bank**: it is linked, never
marked paid again and never called a double payment. The same reference on a
second statement is reported as already reconciled. Bank payments are never
matched on invoice number, supplier or amount alone, and a line for a payment
the bank has not confirmed goes to a person. Undoing a statement removes the
link only; the payment stays paid. Bank reconciliation has a **Reconcile the
simulated bank's statement** button for payers.

## Environment variables (new)

| Variable | Default | |
| --- | --- | --- |
| `ADMIN_SETUP_TOKEN` | empty (off) | One-time token for the first-administrator form. Remove after use. |
| `SESSION_TTL_HOURS` | 12 | |
| `COOKIE_SECURE` | auto | Secure on HTTPS. |
| `LOGIN_MAX_FAILURES`, `LOGIN_LOCK_MINUTES` | 5, 15 | Account lockout. |
| `LOGIN_RATE_LIMIT_WINDOW_MINUTES`, `LOGIN_RATE_LIMIT_MAX` | 15, 20 | Per IP address, per instance. |
| `PAYMENT_CUTOFF`, `PAYMENT_DEFAULT_TIME` | 15:00, 09:00 | In `TIME_ZONE` (default Australia/Sydney). |
| `BUSINESS_DAYS` | Mon-Fri | |
| `BANK_HOLIDAYS` | built-in AU national holidays 2026–2028 | Comma-separated dates; replaces the built-in list. State holidays are not built in. |
| `TICK_MAX_JOBS`, `TICK_BUDGET_SECONDS` | 10, 40 | |
| `JOB_LEASE_SECONDS`, `JOB_MAX_ATTEMPTS`, `BANK_TIMEOUT_MS` | 120, 5, 10000 | |
| `SIM_BANK_DELAY_SECONDS` | 20 (demo) / 120 | |
| `SIM_BANK_DELAYED_SECONDS` | 600 | The "delayed" scenario. |
| `SIM_BANK_OPENING_BALANCE` | 250000 | AUD. |
| `SIM_BANK_BSB_PREFIX` | 999 | |
| `SIM_BANK_TEMPORARY_FAILURES` | 1 | |
| `APP_ENV` | development | Only `production` allows live supplier email. |
| `SUPPLIER_EMAIL_MODE` | outbox | `live` only takes effect with `APP_ENV=production`. |
| `TEST_EMAIL_RECIPIENT` | empty | Where notices go outside production (needs Resend or SMTP). |
| `SUPPLIER_EMAIL_FROM` | `ALERT_FROM` | |

`CRON_SECRET` (existing) is now required for the payment tick too.
`REVIEWERS`, `APPROVERS`, `PAYERS` are no longer used for permissions; they are
read once by `npm run migrate`.

## One-time setup (existing deployment)

Run these from your machine with `MONGODB_URI` pointing at the deployment's
database (in `server/.env`, or exported in the shell):

```
npm install --prefix server
npm run migrate --prefix server -- --dry-run   # shows what it would change
npm run migrate --prefix server                # outbox index, new indexes, roles from the old lists
npm run create-admin --prefix server -- --email you@example.com --name "Your Name"
```

`create-admin` asks for the password at a hidden prompt (or reads
`ADMIN_PASSWORD`). Alternatively set `ADMIN_SETUP_TOKEN` in Vercel, open the
site, use **First-time setup**, then remove the token.

Then sign in as the administrator, create the other users and give them roles
(Admin screen), set up the external scheduler, and in Vercel set `CRON_SECRET`
(if not already set) and any of the variables above.

The app also replaces the old outbox index by itself on its first database
connection, so payment notices work even before `migrate` is run; `migrate` is
still the way to move the role lists and build the indexes up front.
