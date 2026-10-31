// Automatic invoice ingestion: find invoice attachments in a mailbox and send
// each one through the SAME pipeline as a manual upload (readUpload ->
// Invoice -> processInvoice). Imported invoices are ordinary invoices: the
// agent checks them and a person decides. Nothing here approves an invoice,
// schedules or records a payment, or sends an email.
//
//   connect     an administrator signs in to the provider (OAuth + PKCE); the
//               refresh token is stored encrypted (ingestion/secrets.js)
//   sync        list new messages since the cursor, record one IngestionItem per
//               attachment (unique: provider + message + attachment), then
//               process pending items within a time budget
//   process     claim one item atomically, download, check the bytes, hash,
//               read, create the invoice (unique file hash), run the agent
//
// Safe to repeat: a message already recorded is not read again; an item is
// claimed by one worker at a time (with a lease, in case a worker dies); the
// same file never becomes two invoices (unique index); a retry after the
// invoice was created re-runs the agent on that invoice instead of creating
// another. Email bodies are never stored or sent to the AI reader.

import crypto from 'node:crypto';

import { config as appConfig } from '../config.js';
import { IngestionSource, IngestionItem, Invoice } from '../models/index.js';
import { createSealer, randomToken, sha256Hex, pkceChallenge, SecretError } from '../ingestion/secrets.js';
import { ProviderError } from '../ingestion/http.js';
import { triage, checkFile, sha256, senderAllowed } from '../ingestion/attachments.js';
import { createGmail } from '../ingestion/providers/gmail.js';
import { createOutlook } from '../ingestion/providers/outlook.js';
import { redactSecrets } from '../safeUri.js';
import { readUpload } from './uploads.js';
import { processInvoice, visionReader } from './invoices.js';
import { keepInvoiceDocument } from './invoiceDocuments.js';
import { HttpError, recordAudit } from './runs.js';
import { requireActor } from './actor.js';

export const ACTOR = 'Email ingestion';
const LOCK_MS = 90 * 1000; // longer than one sync's budget; a crashed sync frees it after this
const ITEM_LEASE_MS = 3 * 60 * 1000;
const AUTH_TTL_MS = 10 * 60 * 1000; // a sign-in must be finished within this
const OVERLAP_MS = 60 * 60 * 1000; // look back a little before the cursor (late delivery, clock skew)
const MAX_PAGES = 10;
const MAX_TEXT = 200_000;
const BACKOFF_MIN = [1, 5, 15, 60, 240]; // minutes before automatic retry 1, 2, 3, ...
const REQUIRED_SCOPE = { gmail: 'gmail.readonly', outlook: 'mail.read' };

// Reasons safe to put in a redirect URL; the dashboard turns them into messages.
export const CONNECT_ERRORS = ['signin', 'state', 'denied', 'exchange', 'scope', 'config'];

class ConnectError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const safe = (err) => redactSecrets(err?.message || String(err)).slice(0, 300);

export function createIngestion({
  cfg = appConfig.ingestion,
  fetchImpl = (...args) => fetch(...args),
  vision = visionReader,
  read = readUpload,
  process: runAgent = processInvoice,
  keepDocument = keepInvoiceDocument,
  audit = recordAudit,
  now = () => new Date(),
  log = console,
} = {}) {
  const sealer = createSealer(cfg.encryptionKey);
  const providers = {};
  if (cfg.providers.includes('gmail')) providers.gmail = createGmail(cfg.gmail, fetchImpl);
  if (cfg.providers.includes('outlook')) providers.outlook = createOutlook(cfg.outlook, fetchImpl);
  const tokens = new Map(); // provider -> { token, expiresAt }: access tokens live in memory only

  const note = (name, action, { actor = ACTOR, actorId = null, subjectId = name, detail = null, reason = null, from = null, to = null } = {}) =>
    audit({ subjectKind: 'ingestion', subjectId, actor, actorId, action, detail, reason, from, to }).catch((err) =>
      log.error(`Could not write the ingestion audit entry "${action}": ${safe(err)}`),
    );

  function providerFor(name) {
    const p = providers[name];
    if (!p) throw new HttpError(404, 'That mail provider is not set up on this server.');
    return p;
  }

  const redirectUri = (name) => (cfg.redirectBase ? `${cfg.redirectBase}/api/ingestion/oauth/${name}/callback` : null);

  /** What stops this provider from being connected, or null. */
  function configProblem(name) {
    const p = providers[name];
    if (!p) return 'Not listed in INGESTION_PROVIDERS.';
    if (!p.configured) return `Set ${name === 'gmail' ? 'GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET' : 'OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET'}.`;
    if (!sealer.available) return 'Set INGESTION_ENCRYPTION_KEY (32 random bytes, base64 or hex).';
    if (!cfg.redirectBase) return 'Set APP_URL (or INGESTION_REDIRECT_BASE) to this site’s address, for the sign-in redirect.';
    return null;
  }

  // ----- status -----

  async function counts(name) {
    const [byStatus, messages] = await Promise.all([
      IngestionItem.aggregate([{ $match: { provider: name } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      IngestionItem.aggregate([{ $match: { provider: name } }, { $group: { _id: '$messageId' } }, { $count: 'n' }]),
    ]);
    const c = Object.fromEntries(byStatus.map((s) => [s._id, s.n]));
    return {
      emails: messages[0]?.n || 0,
      imported: c.imported || 0,
      duplicates: c.duplicate || 0,
      rejected: c.rejected || 0,
      failed: c.failed || 0,
      pending: (c.pending || 0) + (c.processing || 0),
      withoutInvoice: c.skipped || 0,
    };
  }

  function stateOf(name, doc) {
    if (configProblem(name)) return 'not_configured';
    if (!doc || doc.status === 'disconnected') return 'disconnected';
    if (doc.status === 'error') return 'error';
    return doc.enabled ? 'connected' : 'disabled';
  }

  async function status() {
    const t = now();
    const items = [];
    for (const name of cfg.providers) {
      const p = providers[name];
      const doc = await IngestionSource.findById(name).lean();
      items.push({
        provider: name,
        label: p.label,
        state: stateOf(name, doc),
        problem: configProblem(name),
        where: p.where,
        enabled: Boolean(doc?.enabled),
        account: doc?.account || null,
        scopes: doc?.scopes || [],
        connectedBy: doc?.connectedBy || null,
        connectedAt: doc?.connectedAt || null,
        lastPollAt: doc?.lastPollAt || null,
        lastSuccessAt: doc?.lastSuccessAt || null,
        lastError: doc?.lastError || null,
        syncing: Boolean(doc?.lock && new Date(doc.lock.until) > t),
        counts: await counts(name),
      });
    }
    return {
      providers: items,
      settings: {
        pollMinutes: cfg.pollMinutes,
        maxAttachmentMb: Math.round(cfg.maxAttachmentBytes / 1024 / 1024),
        allowedSenders: cfg.allowedSenders.length,
        maxPerRun: cfg.maxPerRun,
        maxAttempts: cfg.maxAttempts,
      },
    };
  }

  // ----- connecting -----

  async function startConnect(name, user) {
    requireActor(user, 'admin');
    const p = providerFor(name);
    const problem = configProblem(name);
    if (problem) throw new HttpError(409, problem);
    const state = randomToken();
    const verifier = randomToken(48);
    await IngestionSource.updateOne(
      { _id: name },
      { $set: { pendingAuth: { stateHash: sha256Hex(state), verifier: sealer.seal(verifier), byId: String(user.id), expiresAt: new Date(now().getTime() + AUTH_TTL_MS) } } },
      { upsert: true },
    );
    await note(name, 'connect_started', { actor: user.name, actorId: user.id, detail: `Sign-in to ${p.label} started (read-only: ${p.scopes.join(', ')}).` });
    return { url: p.authUrl({ state, challenge: pkceChallenge(verifier), redirectUri: redirectUri(name) }) };
  }

  /** The provider sent the person back. Returns { account } or throws ConnectError (with a safe code). */
  async function completeConnect(name, { code, state, error }, user) {
    requireActor(user, 'admin');
    const p = providerFor(name);
    if (configProblem(name)) throw new ConnectError('config', configProblem(name));
    const hash = sha256Hex(String(state || ''));
    // One use only: take the pending sign-in off the record as it is checked.
    const doc = await IngestionSource.findOneAndUpdate({ _id: name, 'pendingAuth.stateHash': hash }, { $set: { pendingAuth: null } }, { new: false }).lean();
    const pa = doc?.pendingAuth;
    const fail = async (codeName, message) => {
      await note(name, 'connect_failed', { actor: user.name, actorId: user.id, reason: message });
      return new ConnectError(codeName, message);
    };
    if (!state || !pa) throw await fail('state', 'The sign-in could not be matched to one started here, or was already used.');
    if (new Date(pa.expiresAt) < now()) throw await fail('state', 'The sign-in took too long. Start again.');
    if (pa.byId !== String(user.id)) throw await fail('state', 'The sign-in was started by another administrator.');
    if (error) throw await fail('denied', `${p.label} did not grant access (${String(error).slice(0, 60)}).`);
    if (!code) throw await fail('exchange', 'No authorisation code was returned.');

    let t;
    try {
      t = await p.exchangeCode({ code: String(code), verifier: sealer.open(pa.verifier), redirectUri: redirectUri(name) });
    } catch (err) {
      throw await fail('exchange', `The sign-in could not be completed: ${safe(err)}`);
    }
    const granted = t.scopes.map((s) => s.toLowerCase());
    if (granted.length && !granted.some((s) => s.endsWith(REQUIRED_SCOPE[name]))) throw await fail('scope', 'Read access to the mailbox was not granted.');

    const before = await IngestionSource.findById(name).lean();
    const sameAccount = before?.account && t.account && before.account.toLowerCase() === t.account.toLowerCase();
    await IngestionSource.updateOne(
      { _id: name },
      {
        $set: {
          status: 'connected',
          enabled: sameAccount ? Boolean(before.enabled) : false, // an administrator turns polling on
          account: t.account,
          credentials: sealer.seal(t.refreshToken),
          scopes: t.scopes,
          connectedBy: user.name,
          connectedById: String(user.id),
          connectedAt: now(),
          lastError: null,
          ...(sameAccount ? {} : { cursor: null }),
        },
      },
      { upsert: true },
    );
    tokens.set(name, { token: t.accessToken, expiresAt: now().getTime() + (t.expiresIn - 60) * 1000 });
    await note(name, 'connected', {
      actor: user.name,
      actorId: user.id,
      to: 'connected',
      detail: `${p.label}${t.account ? ` (${t.account})` : ''} connected, read-only. Polling stays off until it is enabled.`,
    });
    return { account: t.account };
  }

  async function disconnect(name, user) {
    requireActor(user, 'admin');
    const p = providerFor(name);
    const doc = await IngestionSource.findById(name).lean();
    let revoked = 'nothing stored';
    if (doc?.credentials) {
      try {
        await p.revoke(sealer.open(doc.credentials));
        revoked = name === 'outlook' ? 'stored token deleted (remove the app at myapps.microsoft.com to revoke consent)' : 'revoked at Google';
      } catch (err) {
        revoked = `could not revoke at the provider (${safe(err)}); the stored token is deleted anyway`;
      }
    }
    await IngestionSource.updateOne(
      { _id: name },
      { $set: { status: 'disconnected', enabled: false, credentials: null, pendingAuth: null, account: null, scopes: [] } },
      { upsert: true },
    );
    tokens.delete(name);
    await note(name, 'disconnected', { actor: user.name, actorId: user.id, from: doc?.status || 'disconnected', to: 'disconnected', detail: `Disconnected: ${revoked}.` });
    return { ok: true };
  }

  async function setEnabled(name, enabled, user) {
    requireActor(user, 'admin');
    providerFor(name);
    const doc = await IngestionSource.findById(name).lean();
    if (enabled && !(doc?.status === 'connected' || doc?.status === 'error')) throw new HttpError(409, 'Connect the mailbox first.');
    if (Boolean(doc?.enabled) === Boolean(enabled)) return { enabled: Boolean(enabled) };
    await IngestionSource.updateOne({ _id: name }, { $set: { enabled: Boolean(enabled) } });
    await note(name, enabled ? 'enabled' : 'disabled', {
      actor: user.name,
      actorId: user.id,
      from: String(Boolean(doc?.enabled)),
      to: String(Boolean(enabled)),
      detail: `Automatic polling ${enabled ? 'turned on' : 'turned off'}.`,
    });
    return { enabled: Boolean(enabled) };
  }

  // ----- access tokens -----

  async function markAuthFailure(name, message) {
    tokens.delete(name);
    const changed = await IngestionSource.updateOne({ _id: name, status: 'connected' }, { $set: { status: 'error', lastError: { message, code: 'auth', at: now() } } });
    if (!changed.modifiedCount) await IngestionSource.updateOne({ _id: name, status: 'error' }, { $set: { lastError: { message, code: 'auth', at: now() } } });
    // Only the change to "error" is logged, not every failed poll after it.
    if (changed.modifiedCount) await note(name, 'auth_failed', { from: 'connected', to: 'error', reason: message });
  }

  async function accessToken(name, { force = false } = {}) {
    const cached = tokens.get(name);
    if (!force && cached && cached.expiresAt > now().getTime()) return cached.token;
    const doc = await IngestionSource.findById(name).lean();
    if (!doc?.credentials) throw new ProviderError('The mailbox is not connected.', { kind: 'auth', code: 'not_connected' });
    let refreshToken;
    try {
      refreshToken = sealer.open(doc.credentials);
    } catch (err) {
      throw new ProviderError(err instanceof SecretError ? err.message : 'The stored credentials could not be read.', { kind: 'auth', code: 'credentials' });
    }
    const r = await providers[name].refresh(refreshToken);
    if (r.refreshToken && r.refreshToken !== refreshToken) await IngestionSource.updateOne({ _id: name }, { $set: { credentials: sealer.seal(r.refreshToken) } });
    tokens.set(name, { token: r.accessToken, expiresAt: now().getTime() + (r.expiresIn - 60) * 1000 });
    return r.accessToken;
  }

  // Call the provider; on a 401 (token expired early, or revoked) refresh once and try again.
  async function withToken(name, fn) {
    const token = await accessToken(name);
    try {
      return await fn(token);
    } catch (err) {
      if (!(err instanceof ProviderError && err.status === 401)) throw err;
      return fn(await accessToken(name, { force: true }));
    }
  }

  // ----- discovery -----

  async function recordMessage(name, msg, result) {
    const base = { provider: name, messageId: String(msg.id), from: msg.from || null, subject: msg.subject || null, receivedAt: msg.receivedAt || null };
    const docs = [];
    if (!senderAllowed(msg.from, cfg.allowedSenders)) {
      docs.push({ ...base, attachmentKey: '', status: 'skipped', reason: 'The sender is not on INGESTION_ALLOWED_SENDERS.', finishedAt: now() });
    } else {
      const { eligible, rejected, ignored } = triage(msg.attachments, { maxBytes: cfg.maxAttachmentBytes });
      for (const a of eligible)
        docs.push({ ...base, attachmentKey: a.key, attachmentId: a.attachmentId, filename: a.filename, mimeType: a.mimeType, size: a.size, status: 'pending' });
      for (const a of rejected)
        docs.push({
          ...base,
          attachmentKey: a.key,
          attachmentId: a.attachmentId,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
          status: 'rejected',
          reason: a.reason,
          finishedAt: now(),
        });
      if (!docs.length)
        docs.push({
          ...base,
          attachmentKey: '',
          status: 'skipped',
          reason: `No PDF, JPG or PNG invoice attached${ignored ? ` (${ignored} inline image${ignored === 1 ? '' : 's'} ignored)` : ''}.`,
          finishedAt: now(),
        });
    }
    for (const d of docs) {
      let item;
      try {
        item = await IngestionItem.create(d);
      } catch (err) {
        if (err?.code === 11000) continue; // another worker recorded it first (unique index)
        throw err;
      }
      if (item.status === 'pending') result.found += 1;
      if (item.status === 'skipped') result.withoutInvoice += 1;
      if (item.status === 'rejected') {
        result.rejected += 1;
        await note(name, 'attachment_rejected', {
          subjectId: item._id,
          reason: item.reason,
          detail: `${item.filename} from ${item.from || 'unknown sender'} (message ${item.messageId}).`,
        });
      }
    }
  }

  async function discover(name, doc, deadline, result) {
    const p = providers[name];
    const since = doc.cursor ? new Date(new Date(doc.cursor).getTime() - OVERLAP_MS) : new Date(now().getTime() - cfg.lookbackDays * 86400000);
    let pageToken = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { ids, next } = await withToken(name, (t) => p.listMessages(t, { since, pageToken }));
      for (const id of ids) {
        if (now().getTime() > deadline) return false;
        if (await IngestionItem.exists({ provider: name, messageId: String(id) })) continue;
        const msg = await withToken(name, (t) => p.getMessage(t, id));
        result.emailsChecked += 1;
        await recordMessage(name, msg, result);
      }
      if (!next) return true;
      pageToken = next;
    }
    return false; // more pages than one sync looks at: the cursor stays, the next sync continues
  }

  // ----- processing one attachment -----

  const backoff = (attempts) => BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60 * 1000;

  async function finishAs(item, set, action, detail, reason = null) {
    // Only the worker holding the item finishes it, once.
    const done = await IngestionItem.findOneAndUpdate({ _id: item._id, status: 'processing' }, { $set: { ...set, leaseUntil: null, finishedAt: now() } }, { new: true });
    if (done && action) await note(item.provider, action, { subjectId: item._id, detail, reason });
    return done;
  }

  const reject = (item, reason) => finishAs(item, { status: 'rejected', reason }, 'attachment_rejected', `${item.filename} from ${item.from || 'unknown sender'}.`, reason);

  async function failItem(item, message) {
    const more = item.attempts < cfg.maxAttempts;
    const reason = more ? message : `${message} No more automatic retries: retry it from the Admin screen.`;
    const done = await IngestionItem.findOneAndUpdate(
      { _id: item._id, status: 'processing' },
      { $set: { status: 'failed', reason, leaseUntil: null, nextAttemptAt: more ? new Date(now().getTime() + backoff(item.attempts)) : null } },
      { new: true },
    );
    if (done) await note(item.provider, 'attachment_failed', { subjectId: item._id, reason, detail: `${item.filename}: attempt ${item.attempts} of ${cfg.maxAttempts}.` });
    return done;
  }

  async function markDuplicateFile(item, existingId) {
    return finishAs(
      item,
      { status: 'duplicate', duplicateOf: existingId, duplicateSignals: ['identical file'], reason: 'The same file was already imported.' },
      'duplicate_detected',
      `${item.filename} is the same file as invoice ${existingId}; no new invoice was created.`,
    );
  }

  // After the agent ran: imported (perhaps flagged as a possible duplicate), or failed and retried later.
  async function finish(item, invoiceId) {
    const inv = await Invoice.findById(invoiceId).select('status decision checks match.duplicates extracted.invoiceNumber').lean();
    if (!inv) return failItem(item, 'The invoice created from this attachment no longer exists.');
    if (inv.status === 'failed') return failItem(item, `The invoice could not be read: ${inv.decision?.reasons?.[0] || 'unknown error'}`);
    // The agent's duplicate check (same supplier and number, same total and date, ...): flagged
    // on the invoice for the reviewer; the earlier invoices it matched are in match.duplicates.
    const dup = (inv.checks || []).find((c) => c.id === 'duplicate' && c.status === 'fail');
    const earlier = dup ? (inv.match?.duplicates || []).find((c) => !['rejected', 'cancelled', 'failed'].includes(c.status)) || inv.match?.duplicates?.[0] : null;
    const set = { status: 'imported', reason: null, nextAttemptAt: null };
    if (earlier) Object.assign(set, { duplicateOf: earlier.id, duplicateSignals: earlier.signals || [] });
    const done = await finishAs(
      item,
      set,
      'invoice_imported',
      `Invoice ${inv.extracted?.invoiceNumber || '(no number)'} (${invoiceId}) is ${String(inv.status).replace(/_/g, ' ')}, waiting for a person.`,
    );
    if (done && dup)
      await note(item.provider, 'duplicate_detected', {
        subjectId: item._id,
        detail: `Invoice ${invoiceId} may duplicate ${earlier ? `invoice ${earlier.id}` : 'an earlier invoice'}: ${dup.detail}`,
      });
    return done;
  }

  async function processClaimed(item) {
    const name = item.provider;
    // An earlier attempt already created the invoice: run the agent on it again instead of creating another.
    if (item.invoiceId) {
      const existing = await Invoice.findById(item.invoiceId);
      if (existing?.status === 'failed') await runAgent(existing);
      return finish(item, item.invoiceId);
    }

    let buffer;
    try {
      buffer = await withToken(name, (t) => providers[name].download(t, item.messageId, { key: item.attachmentKey, attachmentId: item.attachmentId }));
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'notFound') return reject(item, 'The email or attachment is no longer in the mailbox.');
      if (err instanceof ProviderError && err.kind === 'auth') {
        // Not this file's fault: put it back as it was, and stop.
        await IngestionItem.updateOne({ _id: item._id, status: 'processing' }, { $set: { status: 'pending', leaseUntil: null }, $inc: { attempts: -1 } });
        throw err;
      }
      return failItem(item, `The attachment could not be downloaded: ${safe(err)}`);
    }

    const kind = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpeg' }[item.mimeType];
    const problem = checkFile(buffer, kind, { maxBytes: cfg.maxAttachmentBytes });
    if (problem) return reject(item, problem);

    const hash = sha256(buffer);
    await IngestionItem.updateOne({ _id: item._id }, { $set: { sha256: hash, size: buffer.length } });
    const same = await Invoice.findOne({ 'source.fileHash': hash }).select('_id').lean();
    if (same) return markDuplicateFile(item, same._id);

    if (kind !== 'pdf' && !vision) return failItem(item, 'Scans and photos need the AI reader: set GROQ_API_KEY, then retry.');
    let reading;
    try {
      reading = await read({ originalname: item.filename, mimetype: item.mimeType, buffer }, { vision });
    } catch (err) {
      // 400: the file cannot be read (damaged, password protected, no text). 422 and others: may work later.
      if (err instanceof HttpError && err.status === 400) return reject(item, err.message);
      return failItem(item, `The invoice reader failed: ${safe(err)}`);
    }
    const rawText = String(reading.rawText || '')
      .replace(/\u0000/g, '')
      .trim();
    if (!rawText) return reject(item, 'No text could be read from the file.');
    if (rawText.length > MAX_TEXT) return reject(item, 'The file has too much text for one invoice.');

    let invoice;
    try {
      invoice = await Invoice.create({
        source: {
          ...reading.source,
          kind: 'email',
          filename: item.filename,
          fileHash: hash,
          email: {
            provider: name,
            messageId: item.messageId,
            attachmentKey: item.attachmentKey,
            from: item.from,
            subject: item.subject,
            receivedAt: item.receivedAt,
            itemId: String(item._id),
          },
        },
        rawText,
      });
    } catch (err) {
      if (err?.code === 11000) {
        // Another worker imported the same file a moment ago.
        const other = await Invoice.findOne({ 'source.fileHash': hash }).select('_id').lean();
        if (other) return markDuplicateFile(item, other._id);
      }
      throw err;
    }
    await IngestionItem.updateOne({ _id: item._id }, { $set: { invoiceId: invoice._id } });
    // The original PDF, so a person can view it in the app (images are not kept).
    if (kind === 'pdf') await keepDocument(invoice._id, { buffer, filename: item.filename, mimetype: item.mimeType });
    await note(name, 'invoice_created', {
      subjectId: item._id,
      detail: `Invoice ${invoice._id} created from ${item.filename} (from ${item.from || 'unknown sender'}, received ${item.receivedAt ? new Date(item.receivedAt).toISOString() : 'unknown'}).`,
    });
    await runAgent(invoice, { reading: reading.reading || null });
    return finish(item, invoice._id);
  }

  const claimable = (t) => [
    { status: 'pending' },
    { status: 'failed', nextAttemptAt: { $ne: null, $lte: t }, attempts: { $lt: cfg.maxAttempts } },
    { status: 'processing', leaseUntil: { $lt: t } }, // a worker that died
  ];

  async function claim(filter) {
    const t = now();
    return IngestionItem.findOneAndUpdate(
      { ...filter, $or: claimable(t) },
      { $set: { status: 'processing', leaseUntil: new Date(t.getTime() + ITEM_LEASE_MS) }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, new: true },
    );
  }

  async function processOne(item, result) {
    let done;
    try {
      done = await processClaimed(item);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth') throw err;
      log.error(`Ingestion item ${item._id} failed: ${safe(err)}`);
      done = await failItem(item, `Something went wrong: ${safe(err)}`);
    }
    const s = done?.status;
    if (s === 'imported') result.imported += 1;
    else if (s === 'duplicate') result.duplicates += 1;
    else if (s === 'rejected') result.rejected += 1;
    else if (s === 'failed') result.failed += 1;
    return done;
  }

  // ----- sync -----

  // trigger 'cron': the scheduler (CRON_SECRET); anything else is an administrator's request.
  async function sync(name, { trigger = 'manual', user = null } = {}) {
    if (trigger !== 'cron') requireActor(user, 'admin');
    providerFor(name);
    const doc = await IngestionSource.findById(name).lean();
    const result = {
      provider: name,
      trigger,
      ran: false,
      emailsChecked: 0,
      found: 0,
      imported: 0,
      duplicates: 0,
      rejected: 0,
      failed: 0,
      withoutInvoice: 0,
      complete: false,
      error: null,
    };
    if (!doc?.credentials || doc.status === 'disconnected') {
      if (trigger === 'manual') throw new HttpError(409, 'Connect the mailbox first.');
      return { ...result, skipped: 'not connected' };
    }
    if (trigger === 'cron') {
      if (!doc.enabled) return { ...result, skipped: 'disabled' };
      if (doc.status === 'error') return { ...result, skipped: 'needs reconnecting' };
      if (doc.lastPollAt && now().getTime() - new Date(doc.lastPollAt).getTime() < cfg.pollMinutes * 60000 - 30000) return { ...result, skipped: 'not due yet' };
    }

    const t0 = now();
    const lockToken = crypto.randomUUID();
    const locked = await IngestionSource.findOneAndUpdate(
      { _id: name, $or: [{ lock: null }, { 'lock.until': { $lt: t0 } }] },
      { $set: { lock: { token: lockToken, until: new Date(t0.getTime() + LOCK_MS) } } },
      { new: true },
    ).lean();
    if (!locked) {
      if (trigger === 'manual') throw new HttpError(409, 'A sync is already running. Wait for it to finish.');
      return { ...result, skipped: 'already running' };
    }

    result.ran = true;
    const deadline = t0.getTime() + cfg.budgetSeconds * 1000;
    if (user) await note(name, 'sync_requested', { actor: user.name, actorId: user.id, detail: 'Sync inbox now.' });
    let lastError = null;
    try {
      result.complete = await discover(name, locked, deadline - (cfg.budgetSeconds * 1000) / 3, result);
      // Process what is waiting (new, or due for a retry) within the budget.
      for (let processed = 0; processed < cfg.maxPerRun && now().getTime() < deadline; processed += 1) {
        const item = await claim({ provider: name });
        if (!item) break;
        await processOne(item, result);
      }
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth') {
        await markAuthFailure(name, err.message);
        lastError = { message: err.message, code: 'auth', at: now() };
      } else {
        lastError = { message: safe(err), code: err instanceof ProviderError ? (err.transient ? 'transient' : 'provider') : 'error', at: now() };
        log.error(`Ingestion sync (${name}) failed: ${lastError.message}`);
      }
      result.error = lastError.message;
    } finally {
      const set = { lastPollAt: now(), lock: null };
      if (!lastError) Object.assign(set, { lastError: null, lastSuccessAt: now(), ...(result.complete ? { cursor: t0 } : {}) });
      else if (lastError.code !== 'auth') set.lastError = lastError;
      // Only clear our own lock.
      await IngestionSource.updateOne({ _id: name, 'lock.token': lockToken }, { $set: set, $inc: { emailsChecked: result.emailsChecked } });
      // Access works again after an earlier authorisation error.
      if (!lastError) {
        const recovered = await IngestionSource.updateOne({ _id: name, status: 'error', credentials: { $ne: null } }, { $set: { status: 'connected' } });
        if (recovered.modifiedCount) await note(name, 'recovered', { from: 'error', to: 'connected', detail: 'The mailbox answered again; the authorisation error is cleared.' });
      }
    }
    const busy = result.emailsChecked || result.imported || result.duplicates || result.failed || result.rejected || result.error;
    if (trigger === 'manual' || busy) {
      await note(name, result.error ? 'sync_failed' : 'sync_completed', {
        actor: user ? user.name : ACTOR,
        actorId: user?.id || null,
        reason: result.error,
        detail: `${trigger === 'manual' ? 'Manual' : 'Scheduled'} sync: ${result.emailsChecked} new email(s), ${result.imported} imported, ${result.duplicates} duplicate(s), ${result.rejected} rejected, ${result.failed} failed.`,
      });
    }
    return result;
  }

  /** Called by the scheduler: every enabled, connected mailbox that is due. */
  async function cronTick() {
    const results = [];
    for (const name of Object.keys(providers)) {
      if (configProblem(name)) continue;
      try {
        results.push(await sync(name, { trigger: 'cron' }));
      } catch (err) {
        results.push({ provider: name, error: safe(err) });
      }
    }
    return { results };
  }

  // ----- the event list and retries -----

  async function listItems({ provider, status, before, limit = 50 } = {}) {
    const filter = {};
    if (provider && providers[provider]) filter.provider = provider;
    if (status && IngestionItem.schema.path('status').enumValues.includes(status)) filter.status = status;
    if (before && !Number.isNaN(Date.parse(before))) filter.createdAt = { $lt: new Date(before) };
    const n = Math.min(100, Math.max(1, Number(limit) || 50));
    const docs = await IngestionItem.find(filter)
      .sort({ createdAt: -1 })
      .limit(n + 1)
      .select('-attachmentId -leaseUntil')
      .lean();
    const page = docs.slice(0, n);
    return { items: await views(page), nextCursor: docs.length > n ? page[page.length - 1].createdAt : null };
  }

  // What the dashboard shows for each item, with the linked invoices' numbers and statuses.
  async function views(docs) {
    const ids = [
      ...new Set(
        docs
          .flatMap((d) => [d.invoiceId, d.duplicateOf])
          .filter(Boolean)
          .map(String),
      ),
    ];
    const invoices = Object.fromEntries(
      (
        await Invoice.find({ _id: { $in: ids } })
          .select('status extracted.invoiceNumber')
          .lean()
      ).map((i) => [String(i._id), i]),
    );
    const link = (id) =>
      id && invoices[String(id)]
        ? { id: String(id), number: invoices[String(id)].extracted?.invoiceNumber || null, status: invoices[String(id)].status }
        : id
          ? { id: String(id), missing: true }
          : null;
    return docs.map((d) => ({
      id: String(d._id),
      provider: d.provider,
      status: d.status,
      reason: d.reason,
      filename: d.filename,
      from: d.from,
      subject: d.subject,
      receivedAt: d.receivedAt,
      attempts: d.attempts,
      nextAttemptAt: d.nextAttemptAt,
      createdAt: d.createdAt,
      finishedAt: d.finishedAt,
      invoice: link(d.invoiceId),
      duplicateOf: link(d.duplicateOf),
      duplicateSignals: d.duplicateSignals || [],
      retryable: d.status === 'failed',
    }));
  }

  async function retry(id, user) {
    requireActor(user, 'admin');
    const item = await IngestionItem.findById(id).lean();
    if (!item) throw new HttpError(404, 'That ingestion record does not exist.');
    providerFor(item.provider);
    if (item.status !== 'failed') throw new HttpError(409, 'Only failed items can be retried.');
    // One more attempt, now: due immediately and below the attempt limit.
    const queued = await IngestionItem.findOneAndUpdate(
      { _id: item._id, status: 'failed' },
      { $set: { nextAttemptAt: now(), attempts: Math.min(item.attempts, cfg.maxAttempts - 1) } },
      { new: true },
    ).lean();
    if (!queued) throw new HttpError(409, 'That item changed. Reload and try again.');
    await note(item.provider, 'retry_requested', { subjectId: item._id, actor: user.name, actorId: user.id, detail: `${item.filename}: retry requested.` });
    const source = await IngestionSource.findById(item.provider).select('status credentials').lean();
    if (!source?.credentials || source.status === 'disconnected') return { item: (await views([queued]))[0], note: 'Queued: it will be processed once the mailbox is connected.' };
    const claimed = await claim({ _id: item._id });
    if (!claimed) return { item: (await views([queued]))[0], note: 'Queued: it will be processed by the next sync.' };
    const result = { imported: 0, duplicates: 0, rejected: 0, failed: 0 };
    try {
      await processOne(claimed, result);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth') {
        await markAuthFailure(item.provider, err.message);
        throw new HttpError(409, `${err.message} The item is queued and will be processed after reconnecting.`);
      }
      throw err;
    }
    const [view] = await views([await IngestionItem.findById(item._id).lean()]);
    return { item: view };
  }

  return { status, startConnect, completeConnect, disconnect, setEnabled, sync, cronTick, listItems, retry, configProblem, providers, redirectBase: cfg.redirectBase };
}

// The app's instance. Tests replace it with configureIngestion({ fetchImpl, vision, cfg, ... }).
let instance = null;
export const ingestion = () => (instance ||= createIngestion());
export function configureIngestion(options) {
  instance = createIngestion(options);
  return instance;
}
export { ConnectError };
