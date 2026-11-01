// The assistant's routes (docs/phase2-design.md §6). Mounted after sign-in and
// requireAnyRole (routes/api.js), so every request has a signed-in person with
// a role; POST and DELETE also pass the app's CSRF check (app.js csrfGuard).
//
//   POST   /api/orchestrator/ask            { question, threadId? } or { threadId, choice }
//   GET    /api/orchestrator/threads/:id    the person's own thread: intents and record ids
//   DELETE /api/orchestrator/threads/:id
//
// The actor is actorOf(req) only (ask.js parseAskBody removes any actor, role
// or user field from the body). A question has its own budget
// (ORCHESTRATOR_BUDGET_SECONDS, 30 s) inside the request's. The pipeline is
// loaded on first use, so other endpoints' cold starts do not evaluate it.

import { actorOf } from '../auth/middleware.js';
import { config } from '../config.js';
import { inRequestDeadline, withDeadline } from '../llm/deadline.js';
import { HttpError } from '../services/runs.js';
import { redactSecrets } from '../safeUri.js';

const GONE = 'That conversation has ended or does not exist.';
const loadPipeline = () => import('../orchestrator/ask.js');
const loadThreads = () => import('../orchestrator/threads.js');

// Our message for a refusal; a plain line for anything unexpected, with the details in the server log only.
function send(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(`Assistant request failed: ${redactSecrets(err?.message ?? String(err))}`);
  return res.status(500).json({ error: 'Your question could not be answered just now.' });
}

export function registerOrchestratorRoutes(api, { work }) {
  api.post('/orchestrator/ask', work, (req, res) =>
    inRequestDeadline(req, async () => {
      res.set('Cache-Control', 'no-store');
      try {
        const { ask, parseAskBody } = await loadPipeline();
        const body = parseAskBody(req.body);
        res.json(await withDeadline(Date.now() + config.orchestrator.budgetSeconds * 1000, () => ask({ actor: actorOf(req), ...body })));
      } catch (err) {
        send(res, err);
      }
    }),
  );

  api.get('/orchestrator/threads/:id', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const { loadThread, threadView } = await loadThreads();
      const thread = await loadThread(actorOf(req), req.params.id);
      if (!thread) throw new HttpError(404, GONE);
      res.json(threadView(thread));
    } catch (err) {
      send(res, err);
    }
  });

  api.delete('/orchestrator/threads/:id', async (req, res) => {
    try {
      const { deleteThread } = await loadThreads();
      if (!(await deleteThread(actorOf(req), req.params.id))) throw new HttpError(404, GONE);
      res.status(204).end();
    } catch (err) {
      send(res, err);
    }
  });
}
