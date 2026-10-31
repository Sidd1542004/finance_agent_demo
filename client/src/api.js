// Thin wrapper around the server API. Every function returns parsed JSON or
// throws an Error whose message is safe to show to the user.
// Empty: the API is on the same site as the dashboard (Vercel, `npm start`, or the
// Vite dev proxy). Set VITE_API_BASE_URL only when the API is hosted elsewhere.
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

const UNREACHABLE = 'Cannot reach the server. Locally, check that the API is running on port 4000 (npm run dev). On Vercel, open /api/health and check the function logs.';

// Fired when the server says the session has ended, so the app shows the sign-in page.
export const SIGNED_OUT = 'foa:signed-out';

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE_URL}/api${path}`, {
      ...options,
      // The session cookie. Cross-site only when the API is hosted elsewhere.
      credentials: API_BASE_URL ? 'include' : 'same-origin',
      // Every call says it comes from the dashboard: the server refuses changes without it (CSRF).
      headers: { 'X-FOA-Request': '1', ...(options.headers || {}) },
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON: handled below */
  }
  if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event(SIGNED_OUT));
  if (!res.ok) throw new Error(data?.error || (res.status >= 500 ? UNREACHABLE : `The request failed (${res.status}).`));
  return data;
}

async function requestText(path) {
  const res = await fetch(`${API_BASE_URL}/api${path}`, { credentials: API_BASE_URL ? 'include' : 'same-origin', headers: { 'X-FOA-Request': '1' } });
  if (!res.ok) throw new Error(`The request failed (${res.status}).`);
  return res.text();
}

// A file (for example an invoice's PDF) as a Blob. A refusal is read as the
// server's JSON message, so it can be shown instead of the file.
async function requestBlob(path) {
  let res;
  try {
    res = await fetch(`${API_BASE_URL}/api${path}`, { credentials: API_BASE_URL ? 'include' : 'same-origin', headers: { 'X-FOA-Request': '1' } });
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (!res.ok) {
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    if (res.status === 401) window.dispatchEvent(new Event(SIGNED_OUT));
    throw new Error(data?.error || (res.status >= 500 ? UNREACHABLE : `The request failed (${res.status}).`));
  }
  return res.blob();
}

// ?before=<cursor>&limit=<n>&filter=..., leaving out what is not set.
const query = (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  return q.toString() ? `?${q}` : '';
};

const json = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export const api = {
  // Open: is the server (and its database) there? Nothing else.
  health: () => request('/health'),
  // Signed in, any role: the reader, the policy, demo controls, time zone.
  status: () => request('/status'),
  // Signed in, any role: invoices read by the rules reader because the AI reader failed.
  invoiceSummary: () => request('/invoices/summary'),

  // Signing in
  me: () => request('/auth/me'),
  login: (email, password) => request('/auth/login', json({ email, password })),
  logout: () => request('/auth/logout', json({})),
  setup: (body) => request('/auth/setup', json(body)),
  changePassword: (currentPassword, newPassword) => request('/auth/password', json({ currentPassword, newPassword })),

  // Administration
  users: () => request('/admin/users'),
  createUser: (body) => request('/admin/users', json(body)),
  updateUser: (id, body) => request(`/admin/users/${id}`, json(body, 'PATCH')),
  resetPassword: (id, password) => request(`/admin/users/${id}/password`, json({ password })),
  runDuePayments: () => request('/admin/run-due', json({})),
  // The agent's policy (Settings tab): { fields: [{ key, label, help, min, max, step, value, default }], version, updatedBy, updatedAt, history }
  policySettings: () => request('/settings/policy'),
  // Administrators: { ...changed values, expectedVersion, reason }. 409 when someone else saved first.
  savePolicySettings: (body) => request('/settings/policy', json(body, 'PUT')),
  simBankAdmin: () => request('/admin/sim-bank'),
  // Automatic invoice ingestion (administrators). No tokens ever reach the dashboard.
  ingestion: () => request('/ingestion'),
  ingestionItems: (params) => request(`/ingestion/items${query(params)}`),
  connectMailbox: (provider) => request(`/ingestion/${provider}/connect`, json({})),
  disconnectMailbox: (provider) => request(`/ingestion/${provider}/disconnect`, json({})),
  setIngestionEnabled: (provider, enabled) => request(`/ingestion/${provider}/enabled`, json({ enabled }, 'PUT')),
  syncMailbox: (provider) => request(`/ingestion/${provider}/sync`, json({})),
  retryIngestion: (id) => request(`/ingestion/items/${id}/retry`, json({})),
  setSimBalance: (balance) => request('/admin/sim-bank/balance', json({ balance }, 'PUT')),
  setSimScenario: (abn, scenario) => request(`/admin/sim-bank/scenarios/${abn}`, json({ scenario }, 'PUT')),

  // Suppliers' (simulated) bank details
  suppliers: () => request('/suppliers'),
  supplierHistory: (abn) => request(`/suppliers/${abn}/history`),
  proposeBankDetails: (abn, body) => request(`/suppliers/${abn}/beneficiary-changes`, json(body)),
  approveBankDetails: (id, note) => request(`/beneficiary-changes/${id}/approve`, json({ note })),
  rejectBankDetails: (id, note) => request(`/beneficiary-changes/${id}/reject`, json({ note })),
  // Approvers and administrators: the full details, with a reason (logged). target: 'pending' | 'current'
  revealBankDetails: (abn, target, reason) => request(`/suppliers/${abn}/bank-details/reveal`, json({ target, reason })),

  // Payments, notices to suppliers, the simulated bank
  payments: (status) => request(`/payments${query({ status })}`),
  payment: (id) => request(`/payments/${id}`),
  paymentCalendar: () => request('/payment-calendar'),
  paymentNotices: (status) => request(`/payment-notices${query({ status })}`),
  draftNotice: (paymentId, kind) => request(`/payments/${paymentId}/notices`, json({ kind })),
  sendNotice: (id) => request(`/payment-notices/${id}/send`, json({})),
  discardNotice: (id, note) => request(`/payment-notices/${id}/discard`, json({ note })),
  simAccount: () => request('/sim-bank/account'),
  simTransactions: () => request('/sim-bank/transactions'),
  simStatementCsv: () => requestText('/sim-bank/statement.csv'),
  samples: () => request('/samples'),
  reference: () => request('/reference'),
  // Lists come a page at a time: { items, nextCursor }.
  invoices: (params) => request(`/invoices${query(params)}`),
  invoice: (id) => request(`/invoices/${id}`),
  // The invoice's original PDF: as a Blob for the viewer, and its address for "Open in a new tab".
  invoiceDocument: (id) => requestBlob(`/invoices/${id}/document`),
  invoiceDocumentUrl: (id) => `${API_BASE_URL}/api/invoices/${id}/document`,
  processSample: (sampleId) => request('/invoices', json({ sampleId })),
  processText: (text) => request('/invoices', json({ text })),
  processFile: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/invoices', { method: 'POST', body: form });
  },
  rerun: (id, body = {}) => request(`/invoices/${id}/rerun`, json(body)),
  decide: (id, body) => request(`/invoices/${id}/approval`, json(body)),
  // Any person's action on an invoice: approve, reject, link_po, schedule_payment, ...
  action: (id, action, body) => request(`/invoices/${id}/actions/${action}`, json(body)),
  payables: () => request('/payables'),
  // `confirm` must be the typed word RESET; the server checks it too.
  reset: (confirm) => request('/reset', json({ confirm })),
  loadDemo: () => request('/demo/load', { method: 'POST' }),

  // Supplier emails
  querySamples: () => request('/query-samples'),
  queries: (params) => request(`/queries${query(params)}`),
  query: (id) => request(`/queries/${id}`),
  processQuerySample: (sampleId) => request('/queries', json({ sampleId })),
  processQuery: (email) => request('/queries', json(email)),
  rerunQuery: (id) => request(`/queries/${id}/rerun`, { method: 'POST' }),
  resolveQuery: (id, body) => request(`/queries/${id}/resolution`, json(body)),

  // Bank reconciliation
  statementSample: () => request('/statement-sample'),
  statements: (params) => request(`/statements${query(params)}`),
  statement: (id) => request(`/statements/${id}`),
  processStatementSample: (sampleId) => request('/statements', json({ sampleId })),
  processStatementText: (text) => request('/statements', json({ text })),
  processStatementFile: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/statements', { method: 'POST', body: form });
  },
  rerunStatement: (id) => request(`/statements/${id}/rerun`, { method: 'POST' }),
  resolveLine: (id, n, body) => request(`/statements/${id}/lines/${n}/resolution`, json(body)),

  // Month-end report
  reports: (params) => request(`/reports${query(params)}`),
  report: (id) => request(`/reports/${id}`),
  writeReport: (month) => request('/reports', json({ month })),
};
