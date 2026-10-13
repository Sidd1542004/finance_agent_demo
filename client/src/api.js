// Thin wrapper around the server API. Every function returns parsed JSON or
// throws an Error whose message is safe to show to the user.

const UNREACHABLE = 'Cannot reach the server. Check that the API is running on port 4000.';

async function request(path, options) {
  let res;
  try {
    res = await fetch(`/api${path}`, options);
  } catch {
    throw new Error(UNREACHABLE);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON: handled below */
  }
  if (!res.ok) throw new Error(data?.error || (res.status >= 500 ? UNREACHABLE : `The request failed (${res.status}).`));
  return data;
}

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  health: () => request('/health'),
  samples: () => request('/samples'),
  reference: () => request('/reference'),
  invoices: () => request('/invoices'),
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
  queries: () => request('/queries'),
  query: (id) => request(`/queries/${id}`),
  processQuerySample: (sampleId) => request('/queries', json({ sampleId })),
  processQuery: (email) => request('/queries', json(email)),
  rerunQuery: (id) => request(`/queries/${id}/rerun`, { method: 'POST' }),
  resolveQuery: (id, body) => request(`/queries/${id}/resolution`, json(body)),

  // Bank reconciliation
  statementSample: () => request('/statement-sample'),
  statements: () => request('/statements'),
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
  reports: () => request('/reports'),
  report: (id) => request(`/reports/${id}`),
  writeReport: (month) => request('/reports', json({ month })),
};
