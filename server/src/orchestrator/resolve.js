// References to records (docs/phase2-design.md §3.3). Every reference the
// person typed, or that a follow-up points back to, becomes exactly one record
// through a lookup tool run as that person, before anything uses it. None or
// several: the person is asked, never a guess.
//
// Each function returns
//   { status: 'one', record: { kind, id }, label }
//   { status: 'several', options: [{ record, label }] }   at most 5, from the lookup
//   { status: 'none' }
//   { status: 'failed', code }                             the lookup itself failed

import { nameKey, invoiceKey } from '../agent/finance/duplicates.js';

const MAX_OPTIONS = 5;
const text = (v) => (v && typeof v === 'object' ? v.untrusted_text : v) ?? '';
const invoiceLabel = (i) => [text(i.invoiceNumber) || 'An invoice without a number', text(i.supplier)].filter(Boolean).join(', ');

/** An invoice by the number the person typed. */
export async function resolveInvoice(exec, typed) {
  const r = await exec.run('find_invoices', { invoiceNumber: String(typed).trim().slice(0, 40) });
  if (!r.ok) return { status: 'failed', code: r.code };
  const items = r.value.items;
  if (!items.length) return { status: 'none' };
  const options = items.map((i) => ({ record: { kind: 'invoice', id: i.id }, label: invoiceLabel(i) }));
  return items.length === 1 ? { status: 'one', ...options[0] } : { status: 'several', options: options.slice(0, MAX_OPTIONS) };
}

/**
 * A supplier by ABN (11 digits as typed) or by name: the same name as
 * duplicate detection compares names (case, punctuation and "Pty Ltd"
 * ignored), else a name that starts with what was typed.
 */
export async function resolveSupplier(exec, typed) {
  const r = await exec.run('list_suppliers', {});
  if (!r.ok) return { status: 'failed', code: r.code };
  const suppliers = r.value.items.filter((s) => s.abn);
  const raw = String(typed).trim();
  let matches;
  if (/^[\d\s]+$/.test(raw) && raw.replace(/\s/g, '').length === 11) {
    matches = suppliers.filter((s) => s.abn === raw.replace(/\s/g, ''));
  } else {
    const key = nameKey(raw);
    if (key.length < 3) return { status: 'none' };
    const exact = suppliers.filter((s) => nameKey(text(s.name)) === key);
    matches = exact.length ? exact : suppliers.filter((s) => nameKey(text(s.name)).startsWith(key));
  }
  if (!matches.length) return { status: 'none' };
  const options = matches.map((s) => ({ record: { kind: 'supplier', id: s.abn }, label: text(s.name) || s.abn }));
  return matches.length === 1 ? { status: 'one', ...options[0] } : { status: 'several', options: options.slice(0, MAX_OPTIONS) };
}

/**
 * "This invoice": the previous turn's one record of `kind`, confirmed by a
 * tool as the person asking (it may have been deleted, or they may not be
 * allowed to read it). The thread holds ids only, never labels.
 */
export async function resolveThis(exec, previous, kind = 'invoice') {
  const records = (previous?.records || []).filter((r) => r.kind === kind);
  if (records.length !== 1) return { status: records.length ? 'several_unlabelled' : 'none' };
  if (kind !== 'invoice') return { status: 'one', record: records[0], label: null };
  const r = await exec.run('get_invoice', { invoiceId: records[0].id });
  if (!r.ok) return r.code === 'not_found' ? { status: 'none' } : { status: 'failed', code: r.code };
  return { status: 'one', record: records[0], label: invoiceLabel(r.value) };
}

/** For record_history: an invoice number first, then a supplier (an ABN or a name). */
export async function resolveRecord(exec, typed) {
  const invoice = await resolveInvoice(exec, typed);
  if (invoice.status !== 'none' || invoiceKey(typed).length === 0) return invoice;
  return resolveSupplier(exec, typed);
}
