# Automatic invoice ingestion (Gmail and Outlook)

The app can read invoice attachments from an accounts-payable mailbox and add
them to **Invoices**, where the agent checks them and a person decides, exactly
as for an uploaded file. It never approves an invoice, schedules or records a
payment, sends, moves or deletes an email.

It is **off** until it is set up and an administrator connects a mailbox and
turns polling on. Without the settings below, everything else works as before.

## How it works

```
mailbox ──(scheduler or "Sync inbox now")──> list new messages since the cursor
   │
   ├─ record one IngestionItem per attachment (unique: provider + message + attachment)
   │     PDF, JPG, PNG only; size limit; inline images and logos ignored;
   │     other files recorded as "rejected"; emails with no invoice as "no invoice"
   │
   └─ for each waiting item (claimed by one worker, with a lease):
         download ─> check the bytes (real PDF/PNG/JPG, not empty, not encrypted)
                 ─> SHA-256: the same file again? link it, no new invoice ("duplicate")
                 ─> readUpload (PDF text, or the Groq vision reader for scans and photos)
                 ─> Invoice (source.kind "email", unique file hash)
                 ─> processInvoice: the same agent as uploads (supplier, ABN, PO and
                    receipt matching, tax, tolerances, duplicate fingerprints)
                 ─> Needs review / Under review / On hold, for a person
```

- **Same pipeline.** `services/ingestion.js` calls `readUpload` and
  `processInvoice` from the upload flow; there is no second invoice pipeline.
  Imported invoices appear on the Invoices screen ("as an email attachment from …").
  An imported PDF is kept with its invoice, like an uploaded one, so a person can
  view it on the invoice page (see "Viewing the original PDF" in the README). On
  Vercel, a PDF over 4.4 MB cannot be sent back to the browser; keep
  `INGESTION_MAX_ATTACHMENT_MB` at 4 there if every PDF must be viewable.
- **Duplicates.** The same file never becomes two invoices (a unique index on
  the file hash, safe with several workers). The same invoice in a different
  file (same supplier and number, or same supplier, total and date) is imported
  and flagged by the agent's existing duplicate check, so it cannot be approved
  or paid until a person clears it. Both are linked to the earlier invoice in
  Admin > Automatic invoice ingestion.
- **Retries.** A provider outage, rate limit or AI reader error marks the item
  failed and retries it later (1, 5, 15, 60 minutes …, up to
  `INGESTION_MAX_ATTEMPTS`). An administrator can retry a failed item at once.
  A retry after the invoice was created re-runs the agent on that invoice; it
  never creates a second one or a second "created" audit entry.
- **Untrusted input.** Email bodies are never stored or read, and never sent to
  the AI reader. Only the sender address, the first 200 characters of the
  subject, the received time and the attachment's name, type, size and hash are
  kept. File names are cleaned. Anything the AI reads only fills invoice fields;
  every rule, status change and permission is still decided by the app.
- **The original file** is not copied into the database (MongoDB documents are
  limited in size and the app has no file store). The invoice keeps the text
  read from it, its SHA-256 and where it came from (provider, message id,
  attachment id), so the original can be found in the mailbox.

### What is stored

| Collection | What | Kept by Reset |
| --- | --- | --- |
| `ingestionsources` | One per provider: connected or not, polling on/off, mailbox address, the refresh token **encrypted** (AES-256-GCM with `INGESTION_ENCRYPTION_KEY`), cursor, last poll, last error, a lock | Yes |
| `ingestionitems` | One per attachment (or per email with no invoice): status, reason, attempts, hash, the invoice it created or matches | No (deleted with the invoices) |
| `invoices` | New: `source.kind: 'email'`, `source.email` (provider, message, sender, subject, received), `source.fileHash` (unique when set) | No |
| `auditevents` | New subject `ingestion` | Yes |

Access tokens live in memory only. Tokens, client secrets and the encryption
key are never returned by the API, written to the audit log or logged.

**Database changes:** new collections and indexes only; no existing data
changes. The indexes are built on first use, or up front with
`npm run migrate --prefix server` (safe to run more than once). The new unique
index on `invoices.source.fileHash` is partial (only invoices that have a file
hash), so existing invoices are not affected.

## Setup

### 1. Settings (server/.env locally, Vercel environment variables in production)

| Variable | |
| --- | --- |
| `INGESTION_PROVIDERS` | `gmail`, `outlook` or `gmail,outlook`. Empty: off. |
| `INGESTION_ENCRYPTION_KEY` | 32 random bytes, base64 or hex: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Changing it means reconnecting. |
| `INGESTION_REDIRECT_BASE` | This site's address. Defaults to `APP_URL`. Locally `http://localhost:5173`. |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` | From Google Cloud (below). |
| `GMAIL_LABEL`, `GMAIL_QUERY` | Default `INBOX` and `has:attachment`. A dedicated label (a Gmail filter that labels supplier invoices) is recommended. |
| `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_TENANT`, `OUTLOOK_FOLDER` | From Microsoft Entra (below). Tenant default `organizations`; folder default `inbox`. |
| `INGESTION_ALLOWED_SENDERS` | Optional: only these addresses or `@domains`. |
| `INGESTION_POLL_MINUTES` (5), `INGESTION_MAX_ATTACHMENT_MB` (10), `INGESTION_LOOKBACK_DAYS` (7), `INGESTION_MAX_PER_RUN` (5), `INGESTION_BUDGET_SECONDS` (40), `INGESTION_MAX_ATTEMPTS` (5) | Tuning. |
| `CRON_SECRET` | Already used by the payment tick; the scheduler sends it to `/api/cron/ingest` too. |

Scans and photos (JPG, PNG, PDFs without a text layer) need `GROQ_API_KEY`,
as for uploads. Without it they are marked failed with that reason, and can be
retried after the key is set.

### 2a. Gmail: Google Cloud OAuth client

1. In Google Cloud Console, create (or pick) a project and enable the **Gmail API**.
2. **OAuth consent screen**: user type *Internal* if the mailbox is in your
   Google Workspace (no verification needed), otherwise *External* and add the
   mailbox as a test user. Add the scope `https://www.googleapis.com/auth/gmail.readonly`
   (a restricted scope: an *External* app used beyond test users needs Google's verification).
3. **Credentials > Create credentials > OAuth client ID**, type *Web application*.
   Authorised redirect URI: `<INGESTION_REDIRECT_BASE>/api/ingestion/oauth/gmail/callback`,
   e.g. `https://your-app.vercel.app/api/ingestion/oauth/gmail/callback`, and
   `http://localhost:5173/api/ingestion/oauth/gmail/callback` for local work.
4. Put the client id and secret in `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`.

Permission requested: **gmail.readonly** only (read messages and attachments).
The app asks for offline access (a refresh token) so polling works without
anyone signed in.

### 2b. Outlook: Microsoft Entra app registration

1. In the Microsoft Entra admin centre, **App registrations > New registration**.
   Supported accounts: this organisation only (then `OUTLOOK_TENANT` = your
   tenant id) or any organisation (`organizations`).
2. Redirect URI, platform **Web**: `<INGESTION_REDIRECT_BASE>/api/ingestion/oauth/outlook/callback`.
3. **Certificates & secrets > New client secret**: put the value in
   `OUTLOOK_CLIENT_SECRET`, and the Application (client) id in `OUTLOOK_CLIENT_ID`.
   Note the secret's expiry date.
4. **API permissions > Microsoft Graph > Delegated**: `Mail.Read` and
   `offline_access` (plus `openid` and `email`, only to show which mailbox is
   connected). Grant admin consent if your tenant requires it.

The app reads the signed-in user's own mailbox folder (`OUTLOOK_FOLDER`).
Reading a shared mailbox would need `Mail.Read.Shared` and is not implemented.

### 3. Connect, turn on, disconnect

1. Sign in to the dashboard as an **administrator** and open **Admin >
   Automatic invoice ingestion**. Each listed provider shows *Not configured*
   (with what is missing), *Not connected*, *Connected*, *Connected, polling off* or *Error*.
2. **Connect** opens the provider's sign-in. Sign in with the accounts-payable
   mailbox and allow read access. You come back to the dashboard; polling is
   **off** until you choose **Turn polling on**.
3. **Sync inbox now** runs one sync immediately (one at a time per mailbox).
4. **Disconnect** stops polling and deletes the stored token (Google: also
   revoked; Microsoft: remove the app at https://myapps.microsoft.com to revoke
   consent). Invoices already imported stay.

Every one of these is in the audit log (subject `ingestion`), with who and when.

### 4. Scheduling (Vercel)

Vercel functions do not run in the background, and on the Hobby plan Vercel
cron jobs run at most once a day. So the polling is an endpoint for a scheduler.
`vercel.json` calls it once a day (21:30 UTC) as a safety net only:

```
GET or POST https://<your-app>/api/cron/ingest
Authorization: Bearer <CRON_SECRET>
```

Point an external scheduler (cron-job.org, Upstash QStash, your own server) at it
every 5 minutes, like the payment tick (see
[payments.md](payments.md#how-often-and-the-vercel-plan)).
`.github/workflows/payment-tick.yml` calls it every 5 minutes as a backup once the
repository secrets `INGEST_URL` and `CRON_SECRET` are set. Calling it more often
is harmless: each mailbox is synced at most every `INGESTION_POLL_MINUTES`. A daily
cron alone would mean invoices arrive up to a day late.

Each sync stops starting new work after `INGESTION_BUDGET_SECONDS` (Vercel gives
a function 60 seconds) and processes at most `INGESTION_MAX_PER_RUN`
attachments; the rest wait for the next sync. A crashed sync frees its lock
after 90 seconds and its item after 3 minutes.

Push notifications (Gmail watch via Google Pub/Sub, Graph change
notifications) are not used: they need a public topic or a validated webhook,
renewal every few days, and still a fallback poll. Polling is simpler and
reliable here.

## Local development

```
# server/.env
INGESTION_PROVIDERS=gmail
INGESTION_ENCRYPTION_KEY=<32 random bytes, base64>
INGESTION_REDIRECT_BASE=http://localhost:5173
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_LABEL=Invoices-test

npm run dev
# Admin > Automatic invoice ingestion > Connect Gmail (a TEST mailbox), then Sync inbox now.
# Or call the scheduler's endpoint:
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:4000/api/cron/ingest
```

Nothing connects to a mailbox until an administrator clicks Connect.

## Tests

```
npm test --prefix server                                       # everything
cd server && node --test test/ingestion.test.js                # just ingestion
cd server && DEBUG_INGESTION=1 node --test test/ingestion.test.js   # with the service's error log
```

The tests use fake Gmail and Microsoft Graph APIs and an in-memory MongoDB:
no real mailbox, network or database.

## Security notes

- Only administrators can see the ingestion screen, connect, disconnect, turn
  polling on or off, sync or retry. Every change needs the dashboard's CSRF
  header; sync and retry are rate limited. The scheduler's endpoint needs `CRON_SECRET`.
- The OAuth sign-in uses PKCE and a one-time `state` that is bound to the
  administrator who started it and expires after 10 minutes. The callback
  answers with a redirect carrying only a result code.
- Read-only scopes. The app cannot send, move or delete mail.
- Refresh tokens are encrypted at rest; the key is only in the environment.
  Anyone with the database and the key can read the mailbox: protect both, and
  rotate the OAuth client secret if either leaks (then reconnect).
- Imported invoices follow every existing control: no approval without an
  approver, segregation of duties, approval blockers, payment rules.
- Consider a dedicated mailbox or label for supplier invoices, and
  `INGESTION_ALLOWED_SENDERS` if your suppliers are known.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| *Not configured: Set …* | The variable named is missing on the server. Set it and redeploy or restart. |
| Back from Google/Microsoft with "the sign-in expired, was already used…" | Took over 10 minutes, the page was reloaded, or another administrator started it. Connect again. |
| "the provider did not complete the sign-in" | The redirect URI in Google/Entra does not match `<INGESTION_REDIRECT_BASE>/api/ingestion/oauth/<provider>/callback` exactly, or the client secret is wrong or expired. |
| "Google did not return a refresh token" | Remove the app at https://myaccount.google.com/permissions and connect again. |
| *Error: reconnect needed* | The refresh token was revoked or expired (password change, consent removed, Entra secret expired, a Google *External* app in testing expires tokens after 7 days), or `INGESTION_ENCRYPTION_KEY` changed. Reconnect. |
| "Gmail has no label called …" | Create the label or change `GMAIL_LABEL`. |
| Items failed with "rate limiting" or "unavailable" | Retried automatically; nothing to do unless it persists. |
| Scans and photos failed with "need the AI reader" | Set `GROQ_API_KEY`, then **Retry** the items. |
| Nothing happens on Vercel | Polling is off, or no scheduler calls `/api/cron/ingest`. Check Admin > Automatic invoice ingestion > Last checked. |
