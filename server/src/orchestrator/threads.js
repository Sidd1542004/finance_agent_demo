// Conversation threads for the assistant (docs/phase2-design.md §10), so a
// follow-up like "this invoice" works. A thread holds only what was asked
// (the intent) and which records the answer showed (kind and id), plus the
// options of a pending clarification. Never the question, an answer, a tool
// result, a name or an amount.
//
// Only its owner can read, use or delete it: every query has the owner's id
// in it, and anything else (someone else's thread, an expired one, a made-up
// id) is simply not found. Administrators get no exception. Threads end 24 h
// after they start: a TTL index deletes them, and every read checks the time
// too, so expiry is exact. Scripts and other system actors have no threads.

import crypto from 'node:crypto';
import { OrchestratorThread } from '../models/index.js';
import { TYPED_ARGS } from './intents.js';

export const THREAD_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_TURNS = 10;
export const MAX_OPTIONS = 6;
export const THREAD_ID = /^t_[A-Za-z0-9_-]{22}$/;
export const OPTION_ID = /^o_[A-Za-z0-9_-]{22}$/;
const RECORD_KINDS = ['invoice', 'payment', 'supplier', 'bank_line'];

const newId = (prefix) => `${prefix}${crypto.randomBytes(16).toString('base64url')}`;
const ownerOf = (actor) => (actor && !actor.system && actor.id ? String(actor.id) : null);
const recordsOf = (records = []) =>
  records
    .filter((r) => RECORD_KINDS.includes(r?.kind) && typeof r.id === 'string' && r.id.length <= 64)
    .slice(0, 100)
    .map((r) => ({ kind: r.kind, id: r.id }));
// An option keeps the intent and its non-text arguments (a stage, a flag): never words the person typed.
const argsOf = (args = {}) =>
  Object.fromEntries(Object.entries(args).filter(([k, v]) => !TYPED_ARGS.includes(k) && ['string', 'boolean'].includes(typeof v) && String(v).length <= 20));

/** The owner's live thread, or null (not theirs, expired, malformed id, or a system actor). */
export async function loadThread(actor, threadId, now = new Date()) {
  const owner = ownerOf(actor);
  if (!owner || typeof threadId !== 'string' || !THREAD_ID.test(threadId)) return null;
  return OrchestratorThread.findOne({ _id: threadId, ownerId: owner, expiresAt: { $gt: now } }).lean();
}

/** The previous turn's intent and records, for "this invoice". */
export function previousTurn(thread) {
  const last = thread?.turns?.[thread.turns.length - 1];
  return last ? { intent: last.intent, records: last.records || [] } : null;
}

/**
 * Options for a clarification: [{ intent, args, records, label }] in, the
 * stored form and the public form ({ optionId, label }) out.
 */
export function makeOptions(list) {
  const stored = [];
  const shown = [];
  for (const o of list.slice(0, MAX_OPTIONS)) {
    const optionId = newId('o_');
    stored.push({ optionId, intent: o.intent, args: argsOf(o.args), records: recordsOf(o.records) });
    shown.push({ optionId, label: o.label });
  }
  return { stored, shown };
}

/**
 * Record a turn (intent and record ids) and the pending options, starting a
 * thread when there is none. Returns the thread id, or null for a system actor.
 */
export async function saveTurn(actor, thread, { intent, records = [], options = [] }, now = new Date()) {
  const owner = ownerOf(actor);
  if (!owner) return null;
  const turn = { at: now, intent, records: recordsOf(records) };
  if (!thread) {
    const _id = newId('t_');
    await OrchestratorThread.create({ _id, ownerId: owner, expiresAt: new Date(now.getTime() + THREAD_TTL_MS), turns: [turn], options });
    return _id;
  }
  await OrchestratorThread.updateOne({ _id: thread._id, ownerId: owner, expiresAt: { $gt: now } }, { $push: { turns: { $each: [turn], $slice: -MAX_TURNS } }, $set: { options } });
  return thread._id;
}

/** Take one pending option (once): the stored intent, args and records, or null. */
export async function takeOption(actor, threadId, optionId, now = new Date()) {
  const owner = ownerOf(actor);
  if (!owner || !THREAD_ID.test(String(threadId)) || !OPTION_ID.test(String(optionId))) return null;
  const before = await OrchestratorThread.findOneAndUpdate(
    { _id: threadId, ownerId: owner, expiresAt: { $gt: now }, 'options.optionId': optionId },
    { $set: { options: [] } },
    { new: false },
  ).lean();
  const o = before?.options?.find((x) => x.optionId === optionId);
  return o ? { intent: o.intent, args: o.args || {}, records: o.records || [] } : null;
}

/** Delete the owner's thread. True if there was one. */
export async function deleteThread(actor, threadId) {
  const owner = ownerOf(actor);
  if (!owner || typeof threadId !== 'string' || !THREAD_ID.test(threadId)) return false;
  return (await OrchestratorThread.deleteOne({ _id: threadId, ownerId: owner })).deletedCount === 1;
}

/** What GET /api/orchestrator/threads/:id shows: ids only, no labels. */
export const threadView = (t) => ({ threadId: t._id, expiresAt: t.expiresAt, turns: (t.turns || []).map((x) => ({ at: x.at, intent: x.intent, records: x.records || [] })) });
