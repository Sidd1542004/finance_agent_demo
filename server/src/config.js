import 'dotenv/config';
import { businessTimeZone } from './agent/finance/timeZone.js';

const list = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const num = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 4000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/finance_agent',

  // Sites allowed to call the API from a browser (comma-separated). Only needed when the
  // dashboard is served from a different site than the API. Empty: no CORS headers.
  corsOrigins: list(process.env.CORS_ORIGINS),

  // Leave GROQ_API_KEY empty to use the basic pattern reader instead of AI.
  groqApiKey: (process.env.GROQ_API_KEY || '').trim(),
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  // A Groq model that accepts images, for scanned and photographed invoices.
  groqVisionModel: process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b',

  // Optional override for Node's DNS resolver (see server/.env.example). Empty by default.
  dnsServers: (process.env.DNS_SERVERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // The business's time zone: "today", due dates, overdue and report months follow it.
  timeZone: businessTimeZone(),

  // The business the agent works for. Used to sign replies to suppliers.
  companyName: process.env.COMPANY_NAME || 'Meridian Logistics Pty Ltd',

  // Demo mode enables the "Load demo month" and "Reset" buttons. Only when DEMO_MODE=true.
  demoMode:
    String(process.env.DEMO_MODE || '')
      .trim()
      .toLowerCase() === 'true',

  // Optional daily summary email (GET /api/cron/daily-summary, called by a Vercel cron job).
  alerts: {
    recipients: list(process.env.ALERT_EMAILS),
    from: process.env.ALERT_FROM || 'Finance Operations Agent <onboarding@resend.dev>',
    appUrl: (process.env.APP_URL || '').trim(),
    cronSecret: process.env.CRON_SECRET || '',
    resendApiKey: (process.env.RESEND_API_KEY || '').trim(),
    smtp: {
      host: (process.env.SMTP_HOST || '').trim(),
      port: num(process.env.SMTP_PORT, 587),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  },

  // The most time one request may take, in seconds: every /api request runs with this
  // deadline (app.js), and an AI reader call never waits past it. Under Vercel's
  // maxDuration (300 s in vercel.json), with room to answer.
  requestBudgetSeconds: Math.max(5, num(process.env.REQUEST_BUDGET_SECONDS, 270)),

  // The scheduler endpoints (/api/cron/*, routes/cron.js): refused requests from one
  // address before it is slowed down (429). CRON_FAILURE_LIMIT=0 turns it off.
  cron: {
    failureLimit: num(process.env.CRON_FAILURE_LIMIT, 20),
    failureWindowMinutes: num(process.env.CRON_FAILURE_WINDOW_MINUTES, 15),
  },

  // Optional shared password for the whole site (HTTP Basic auth, any user name).
  accessPassword: process.env.ACCESS_PASSWORD || '',

  // Requests that call Groq or process files, per client IP address, per server
  // instance (on Vercel each warm instance counts separately).
  rateLimit: {
    windowMinutes: num(process.env.RATE_LIMIT_WINDOW_MINUTES, 10),
    max: num(process.env.RATE_LIMIT_MAX, 30),
  },

  // Optional Australian Business Register lookup. Free GUID: https://abr.business.gov.au/Tools/WebServices
  // Without it, ABNs are checked for a valid number only and shown as "not verified".
  abrGuid: (process.env.ABR_GUID || '').trim(),

  // Which environment this is. Only APP_ENV=production counts as production
  // (never inferred from NODE_ENV or Vercel), so a demo or preview can never
  // send real email by accident. See services/emailDelivery.js.
  appEnv:
    String(process.env.APP_ENV || 'development')
      .trim()
      .toLowerCase() || 'development',

  // Logins (see auth/). Sessions live in MongoDB; the browser holds an
  // http-only cookie with a random token.
  auth: {
    sessionTtlHours: num(process.env.SESSION_TTL_HOURS, 12),
    // auto: Secure when the request came over HTTPS (Vercel). true / false force it.
    cookieSecure: ['true', 'false'].includes(String(process.env.COOKIE_SECURE || '').toLowerCase()) ? process.env.COOKIE_SECURE.toLowerCase() === 'true' : 'auto',
    // Optional one-time token for POST /api/auth/setup (first administrator, only while no user exists).
    setupToken: (process.env.ADMIN_SETUP_TOKEN || '').trim(),
    maxFailedLogins: num(process.env.LOGIN_MAX_FAILURES, 5),
    lockMinutes: num(process.env.LOGIN_LOCK_MINUTES, 15),
    loginRateLimit: { windowMinutes: num(process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES, 15), max: num(process.env.LOGIN_RATE_LIMIT_MAX, 20) },
  },

  // Payment scheduling and execution (see agent/finance/businessDays.js and
  // services/paymentExecution.js). Times are wall-clock times in TIME_ZONE.
  payments: {
    cutoff: process.env.PAYMENT_CUTOFF || '15:00', // last time on a business day a bank payment can run
    defaultTime: process.env.PAYMENT_DEFAULT_TIME || '09:00', // when a payment runs if no time is chosen
    businessDays: process.env.BUSINESS_DAYS || 'Mon-Fri',
    // Comma-separated YYYY-MM-DD. Empty: the built-in Australian national public holidays.
    holidays: list(process.env.BANK_HOLIDAYS),
    tickMaxJobs: num(process.env.TICK_MAX_JOBS, 10),
    tickBudgetSeconds: num(process.env.TICK_BUDGET_SECONDS, 40), // well inside the request budget below
    leaseSeconds: num(process.env.JOB_LEASE_SECONDS, 120),
    maxAttempts: num(process.env.JOB_MAX_ATTEMPTS, 5),
    bankTimeoutMs: num(process.env.BANK_TIMEOUT_MS, 10000),
  },

  // The simulated bank (SIMULATED: no real bank is ever contacted).
  simBank: {
    // Seconds from acceptance to completion. Default 20 in demo mode, 120 otherwise.
    delaySeconds: num(
      process.env.SIM_BANK_DELAY_SECONDS,
      String(process.env.DEMO_MODE || '')
        .trim()
        .toLowerCase() === 'true'
        ? 20
        : 120,
    ),
    delayedSeconds: num(process.env.SIM_BANK_DELAYED_SECONDS, 600), // the "delayed completion" scenario
    openingBalance: num(process.env.SIM_BANK_OPENING_BALANCE, 250000),
    // Simulated BSBs must start with this. No real bank details are accepted.
    bsbPrefix: String(process.env.SIM_BANK_BSB_PREFIX || '999').replace(/\D/g, '') || '999',
    temporaryFailures: num(process.env.SIM_BANK_TEMPORARY_FAILURES, 1), // attempts refused in the "temporary failure" scenario
  },

  // Payment notices to suppliers (services/emailDelivery.js). Real delivery to a
  // supplier needs BOTH APP_ENV=production AND SUPPLIER_EMAIL_MODE=live. Otherwise
  // a notice goes to TEST_EMAIL_RECIPIENT (if set and a mailer is configured),
  // or stays in the simulated outbox. No dashboard setting can change this.
  supplierEmail: {
    mode: ['live', 'outbox'].includes(String(process.env.SUPPLIER_EMAIL_MODE || '').toLowerCase()) ? process.env.SUPPLIER_EMAIL_MODE.toLowerCase() : 'outbox',
    testRecipient: (process.env.TEST_EMAIL_RECIPIENT || '').trim(),
    from: process.env.SUPPLIER_EMAIL_FROM || process.env.ALERT_FROM || 'Finance Operations Agent <onboarding@resend.dev>',
  },

  // Earlier typed-name role lists. Replaced by user accounts and roles; read
  // only by `npm run migrate` (see scripts/migrate.js) and internal callers
  // that pass no signed-in user (the tests). The API never uses them.
  roles: {
    reviewers: list(process.env.REVIEWERS),
    approvers: list(process.env.APPROVERS),
    payers: list(process.env.PAYERS),
  },

  // Defaults. An administrator can adjust the numeric ones on the Admin screen
  // (services/policySettings.js); a saved value replaces the default here.
  policy: {
    // Match score (0-100) at or above which a clean invoice is ELIGIBLE FOR APPROVAL REVIEW.
    // It is never approved automatically.
    matchThreshold: num(process.env.MATCH_THRESHOLD, 99),
    // A missing ABN sends the invoice to Needs Review ("review") or On Hold ("hold").
    missingAbn: process.env.MISSING_ABN_POLICY === 'hold' ? 'hold' : 'review',
    // When true, the person who approved an invoice cannot also schedule or record its payment.
    segregateDuties: process.env.SEGREGATE_DUTIES === 'true',
    priceTolerancePct: num(process.env.PRICE_TOLERANCE_PCT, 2), // unit price may differ from the PO by this much
    minConfidence: num(process.env.MIN_CONFIDENCE, 0.99), // below this, a person reviews the invoice's reading
    emailMinConfidence: num(process.env.MIN_EMAIL_CONFIDENCE, 0.8), // below this, a person reviews a supplier email
    gstRatePct: 10, // Australian GST
    roundingTolerance: 0.05, // dollars allowed for rounding differences
  },

  // Automatic invoice ingestion from a mailbox (see docs/ingestion.md). Off
  // unless INGESTION_PROVIDERS lists a provider whose OAuth client is set and
  // INGESTION_ENCRYPTION_KEY is set. Secrets stay on the server.
  ingestion: {
    providers: list(process.env.INGESTION_PROVIDERS)
      .map((p) => p.toLowerCase())
      .filter((p) => ['gmail', 'outlook'].includes(p)),
    // 32 random bytes, base64 or hex: encrypts the stored refresh tokens (AES-256-GCM).
    encryptionKey: (process.env.INGESTION_ENCRYPTION_KEY || '').trim(),
    // Where the provider sends the person back: <base>/api/ingestion/oauth/<provider>/callback.
    redirectBase: (process.env.INGESTION_REDIRECT_BASE || process.env.APP_URL || '').trim().replace(/\/+$/, ''),
    gmail: {
      clientId: (process.env.GMAIL_CLIENT_ID || '').trim(),
      clientSecret: (process.env.GMAIL_CLIENT_SECRET || '').trim(),
      label: (process.env.GMAIL_LABEL || 'INBOX').trim(), // a label name or id, e.g. "Invoices"
      query: (process.env.GMAIL_QUERY || 'has:attachment').trim(), // Gmail search, added to the date filter
    },
    outlook: {
      clientId: (process.env.OUTLOOK_CLIENT_ID || '').trim(),
      clientSecret: (process.env.OUTLOOK_CLIENT_SECRET || '').trim(),
      tenant: (process.env.OUTLOOK_TENANT || 'organizations').trim(),
      folder: (process.env.OUTLOOK_FOLDER || 'inbox').trim(), // a well-known name or a folder id
    },
    // Optional: only these senders (addresses or @domains). Empty: anyone.
    allowedSenders: list(process.env.INGESTION_ALLOWED_SENDERS).map((s) => s.toLowerCase()),
    pollMinutes: Math.max(1, num(process.env.INGESTION_POLL_MINUTES, 5)), // the scheduler may call more often; syncs are spaced by this
    maxAttachmentBytes: Math.max(1, num(process.env.INGESTION_MAX_ATTACHMENT_MB, 10)) * 1024 * 1024,
    lookbackDays: Math.max(1, num(process.env.INGESTION_LOOKBACK_DAYS, 7)), // the first sync looks this far back
    maxPerRun: Math.max(1, num(process.env.INGESTION_MAX_PER_RUN, 5)), // attachments processed per sync
    budgetSeconds: Math.max(5, num(process.env.INGESTION_BUDGET_SECONDS, 40)), // stop starting new work after this (each sync is also bounded by requestBudgetSeconds)
    maxAttempts: Math.max(1, num(process.env.INGESTION_MAX_ATTEMPTS, 5)),
  },
};
