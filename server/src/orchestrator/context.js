// The context every orchestrator tool call runs in (docs/agentic-analysis.md §9).
//
//   const ctx = createToolContext({ actor: actorOf(req), runId });
//   await callTool(ctx, 'list_invoices', { filter: 'waiting' });   // tools.js
//
// actor: the person the run acts for. It must be an actor this server built
// itself: actorOf(req) from a signed-in session, or a named system actor
// (auth/roles.js). Anything else, such as an object made from a request body or
// from a model's output, is refused with 401, the same rule the services apply
// (services/actor.js requireActor). The model never supplies the actor.
//
// The context also keeps every record id a tool returned in this run, so a
// later step can check that an id the model names came from a tool result and
// was not made up (id provenance, §10.5; used from Phase 4).

import { requireActor } from '../services/actor.js';

const RUN_ID = /^[A-Za-z0-9:_-]{1,64}$/;
const CONTEXTS = new WeakSet();

export function createToolContext({ actor, runId } = {}) {
  requireActor(actor); // 401 unless an authenticated actor
  const id = String(runId ?? '').trim();
  if (!RUN_ID.test(id)) throw new Error('A tool context needs a run id: 1 to 64 letters, digits, "-", "_" or ":".');
  const returned = new Set();
  const ctx = Object.freeze({
    actor,
    runId: id,
    /** Called by tools.js with the ids in a tool's result. */
    remember(ids) {
      for (const v of ids) if (typeof v === 'string' && v) returned.add(v);
    },
    /** Did a tool return this id earlier in this run? */
    hasSeen: (value) => returned.has(String(value)),
    seenIds: () => [...returned],
  });
  CONTEXTS.add(ctx);
  return ctx;
}

/** Only contexts made by createToolContext count, whatever fields a look-alike has. */
export const isToolContext = (ctx) => Boolean(ctx) && typeof ctx === 'object' && CONTEXTS.has(ctx);
