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

// ?before=<cursor>&limit=<n>&filter=..., leaving out what is not set.
const query = (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  return q.toString() ? `?${q}` : '';
};

const json = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export const api = {
  health: () => request('/health'),

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
  simBankAdmin: () => request('/admin/sim-bank'),
  setSimBalance: (balance) => request('/admin/sim-bank/balance', json({ balance }, 'PUT')),
  setSimScenario: (abn, scenario) => request(`/admin/sim-bank/scenarios/${abn}`, json({ scenario }, 'PUT')),

  // Suppliers' (simulated) bank details
  suppliers: () => request('/suppliers'),
  supplierHistory: (abn) => request(`/suppliers/${abn}/history`),
  proposeBankDetails: (abn, body) => request(`/suppliers/${abn}/beneficiary-changes`, json(body)),
  approveBankDetails: (id, note) => request(`/beneficiary-changes/${id}/approve`, json({ note })),
  rejectBankDetails: (id, note) => request(`/beneficiary-changes/${id}/reject`, json({ note })),

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
  reset: () => request('/reset', { method: 'POST' }),
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
