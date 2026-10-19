import 'dotenv/config';
import { businessTimeZone } from './agent/finance/timeZone.js';

const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

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
  demoMode: String(process.env.DEMO_MODE || '').trim().toLowerCase() === 'true',

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

  // Who may do what. Comma-separated names; empty means anyone (demo).
  // These are typed names, not logins: real roles need authentication.
  roles: {
    reviewers: list(process.env.REVIEWERS),
    approvers: list(process.env.APPROVERS),
    payers: list(process.env.PAYERS),
  },

  // Sample defaults. Agree the real values with the client's finance team.
  policy: {
    // Match score (0-100) at or above which a clean invoice is ELIGIBLE FOR APPROVAL REVIEW.
    // It is never approved automatically.
    matchThreshold: num(process.env.MATCH_THRESHOLD, 85),
    // A missing ABN sends the invoice to Needs Review ("review") or On Hold ("hold").
    missingAbn: process.env.MISSING_ABN_POLICY === 'hold' ? 'hold' : 'review',
    // When true, the person who approved an invoice cannot also schedule or record its payment.
    segregateDuties: process.env.SEGREGATE_DUTIES === 'true',
    priceTolerancePct: num(process.env.PRICE_TOLERANCE_PCT, 2), // unit price may differ from the PO by this much
    minConfidence: num(process.env.MIN_CONFIDENCE, 0.8), // below this, a person reviews the reading
    gstRatePct: 10, // Australian GST
    roundingTolerance: 0.05, // dollars allowed for rounding differences
  },
};
