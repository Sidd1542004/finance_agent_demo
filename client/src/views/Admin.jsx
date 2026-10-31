import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { money, when, ROLE_LABEL } from '../format.js';
import { useBusy } from '../shared.jsx';
import Ingestion from './Ingestion.jsx';

// Administrators: user accounts and roles, and the simulated bank's settings
// (balance, per-supplier test scenarios). Everything here is logged.
const SCENARIO_LABEL = {
  success: 'Success',
  delayed: 'Delayed completion',
  settle_failure: 'Accepted, then fails',
  rejection: 'Rejected by the bank',
  invalid_beneficiary: 'Invalid beneficiary',
  unsupported_method: 'Unsupported method',
  temporary_failure: 'Temporary failure (first attempt)',
};

export default function AdminView({ user, onError, onNotice, openInvoice }) {
  const [users, setUsers] = useState({ items: [], roles: [] });
  const [bank, setBank] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [busy, run] = useBusy(onError);

  const load = useCallback(async () => {
    const [u, b, s] = await Promise.all([api.users(), api.simBankAdmin(), api.suppliers()]);
    setUsers(u);
    setBank(b);
    setSuppliers(s.items);
  }, []);

  useEffect(() => {
    load().catch((err) => onError(err.message));
  }, [load, onError]);

  const act = (key, fn) =>
    run(key, async () => {
      await fn();
      await load();
    });

  return (
    <div className="admin">
      <Users users={users} me={user} busy={busy} act={act} />
      {bank && <SimBank bank={bank} suppliers={suppliers} busy={busy} act={act} />}
      <Ingestion onError={onError} onNotice={onNotice} openInvoice={openInvoice} />
    </div>
  );
}

const NEW_USER = { email: '', name: '', password: '', roles: [] };

function Users({ users, me, busy, act }) {
  const [form, setForm] = useState(NEW_USER);
  const toggle = (list, role) => (list.includes(role) ? list.filter((r) => r !== role) : [...list, role]);
  const working = Boolean(busy);
  return (
    <section className="panel">
      <h2>Users and roles</h2>
      <p className="hint">
        Reviewer: checks invoices and supplier emails. Approver: approves invoices and bank-detail changes. Payer: schedules payments and reconciles the bank. Administrator: users,
        the simulated bank and the demo data, and everything the other roles can do. The same checks still apply: with SEGREGATE_DUTIES=true nobody pays an invoice they approved,
        and bank-detail changes always need a second person.
      </p>
      <div className="table-scroll">
        <table className="lines">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              {users.roles.map((r) => (
                <th key={r} scope="col">
                  {ROLE_LABEL[r]}
                </th>
              ))}
              <th scope="col">Last sign-in</th>
              <th scope="col">Account</th>
            </tr>
          </thead>
          <tbody>
            {users.items.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.name}
                  {u.locked ? <span className="tag tag-err">Locked</span> : null}
                </td>
                <td>{u.email}</td>
                {users.roles.map((r) => (
                  <td key={r}>
                    <input
                      type="checkbox"
                      aria-label={`${u.name}: ${ROLE_LABEL[r]}`}
                      checked={u.roles.includes(r)}
                      disabled={working || (u.id === me.id && r === 'admin')}
                      onChange={() => act(`roles-${u.id}`, () => api.updateUser(u.id, { roles: toggle(u.roles, r) }))}
                    />
                  </td>
                ))}
                <td>{u.lastLoginAt ? when(u.lastLoginAt) : 'Never'}</td>
                <td className="row-actions">
                  <button className="btn btn-outline" disabled={working || u.id === me.id} onClick={() => act(`active-${u.id}`, () => api.updateUser(u.id, { active: !u.active }))}>
                    {u.active ? 'Deactivate' : 'Reactivate'}
                  </button>
                  <button
                    className="btn btn-outline"
                    disabled={working}
                    onClick={() => {
                      const pw = window.prompt(`New password for ${u.name} (at least 12 characters). They will be signed out everywhere.`);
                      if (pw) act(`pw-${u.id}`, () => api.resetPassword(u.id, pw));
                    }}
                  >
                    Set password
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="sub-head">Add a user</h3>
      <div className="decision-fields">
        <div>
          <label className="field-label" htmlFor="nu-name">
            Name
          </label>
          <input id="nu-name" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <label className="field-label" htmlFor="nu-email">
            Email
          </label>
          <input id="nu-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div>
          <label className="field-label" htmlFor="nu-pw">
            Temporary password (12+ characters)
          </label>
          <input id="nu-pw" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </div>
      </div>
      <div className="role-picks">
        {users.roles.map((r) => (
          <label key={r}>
            <input type="checkbox" checked={form.roles.includes(r)} onChange={() => setForm({ ...form, roles: toggle(form.roles, r) })} /> {ROLE_LABEL[r]}
          </label>
        ))}
      </div>
      <div className="decision-actions">
        <button
          className="btn btn-primary"
          disabled={working || !form.email || !form.name || form.password.length < 12}
          onClick={() =>
            act('create', async () => {
              await api.createUser(form);
              setForm(NEW_USER);
            })
          }
        >
          Add user
        </button>
      </div>
    </section>
  );
}

function SimBank({ bank, suppliers, busy, act }) {
  const [balance, setBalance] = useState('');
  const scenarioOf = (abnValue) => bank.scenarios.find((s) => s.abn === abnValue)?.scenario || 'success';
  const a = bank.account;
  const working = Boolean(busy);
  return (
    <section className="panel">
      <h2>
        Simulated bank <span className="tag tag-sim">Simulated: no real bank, no real money</span>
      </h2>
      <dl className="fields">
        <div>
          <dt>Account</dt>
          <dd>
            {a.name} ({a.bsb} {a.accountNumber})
          </dd>
        </div>
        <div>
          <dt>Balance</dt>
          <dd>{money(a.balance)}</dd>
        </div>
        <div>
          <dt>Accepted, not settled</dt>
          <dd>{money(a.reserved)}</dd>
        </div>
        <div>
          <dt>Available</dt>
          <dd>{money(a.available)}</dd>
        </div>
        <div>
          <dt>Supplier emails</dt>
          <dd>{bank.delivery.note}</dd>
        </div>
      </dl>
      <div className="decision-fields">
        <div>
          <label className="field-label" htmlFor="sb-balance">
            Set the simulated balance (AUD)
          </label>
          <input id="sb-balance" type="number" min="0" step="0.01" value={balance} onChange={(e) => setBalance(e.target.value)} />
        </div>
      </div>
      <div className="decision-actions">
        <button className="btn btn-outline" disabled={working || balance === ''} onClick={() => act('balance', () => api.setSimBalance(Number(balance)))}>
          Set balance
        </button>
      </div>
      <p className="hint">A payment for more than the available balance is rejected as insufficient funds. Confirmed payments reduce the balance.</p>

      <h3 className="sub-head">Test scenario per supplier</h3>
      <p className="hint">Decides what the simulated bank does with that supplier's next payments. Never random.</p>
      <div className="table-scroll">
        <table className="lines lines-narrow">
          <tbody>
            {suppliers.map((s) => (
              <tr key={s.abn}>
                <th scope="row">{s.name}</th>
                <td>
                  <select
                    aria-label={`Scenario for ${s.name}`}
                    value={scenarioOf(s.abn)}
                    disabled={working}
                    onChange={(e) => {
                      const scenario = e.target.value;
                      act(`scenario-${s.abn}`, () => api.setSimScenario(s.abn, scenario));
                    }}
                  >
                    {bank.scenarioNames.map((n) => (
                      <option key={n} value={n}>
                        {SCENARIO_LABEL[n] || n}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
