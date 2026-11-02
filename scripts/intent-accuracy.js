// How accurately does the assistant work out what a question means
// (docs/phase2-design.md §12.1)? Runs the fixture questions
// (server/test/fixtures/orchestrator-questions.json) through the keyword
// router and the real classify call on Groq, and reports:
//   - accuracy: the expected intent and arguments, or asking back where the
//     fixture expects that;
//   - wrong without asking: a different intent or wrong arguments, marked
//     clear (it would have run without asking) - the target is 0;
//   - asked back: unclear or unknown where an answer was expected (safe, not accurate);
//   - tokens, p50/p95 latency of the model calls, and rate limits.
// Not part of the test suite: it calls Groq (once per question the router
// leaves to the model, or for every question with --model-only).
//
//   node scripts/intent-accuracy.js                         as the assistant runs (router first)
//   node scripts/intent-accuracy.js --model-only            every question to the model
//   node scripts/intent-accuracy.js --model openai/gpt-oss-20b
//   node scripts/intent-accuracy.js --reasoning-effort low
//   node scripts/intent-accuracy.js --out results.json      also write each question's result
//   node scripts/intent-accuracy.js --dry-run               the router's results only; no Groq call
//
// GROQ_API_KEY and GROQ_MODEL come from the environment, or else from
// server/.env (only those two are read from it). The key is never printed.
// Like scripts/groq-json-check.js, it runs against a THROWAWAY test database
// (MONGODB_TEST_URI if set, otherwise an in-memory MongoDB) and refuses to run
// otherwise; classification itself reads no records.
// Calls are paced (--pace-ms, default 8000) to stay inside Groq's per-minute
// token limit (8K tokens a minute for openai/gpt-oss-120b, 2026-11-01).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'server');
const fromServer = (p) => import(pathToFileURL(path.join(serverDir, p)).href);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const dryRun = flag('--dry-run');
const modelOnly = flag('--model-only');
const outFile = option('--out');
const paceMs = Number(option('--pace-ms', 8000));
const effort = option('--reasoning-effort');
if (effort && !['low', 'medium', 'high'].includes(effort)) {
  console.error('--reasoning-effort must be low, medium or high.');
  process.exit(2);
}
const COOL_DOWN_MS = 30000;
const RATE_LIMIT_RETRIES = 3;

// ----- the key and model: environment first, then server/.env (GROQ_* only) -----
function groqSettings() {
  let fileVars = {};
  const envFile = path.join(serverDir, '.env');
  if ((!process.env.GROQ_API_KEY || !process.env.GROQ_MODEL) && fs.existsSync(envFile)) {
    const { parse } = createRequire(path.join(serverDir, 'package.json'))('dotenv');
    const all = parse(fs.readFileSync(envFile));
    fileVars = { GROQ_API_KEY: all.GROQ_API_KEY, GROQ_MODEL: all.GROQ_MODEL };
  }
  return { apiKey: String(process.env.GROQ_API_KEY || fileVars.GROQ_API_KEY || '').trim(), model: String(process.env.GROQ_MODEL || fileVars.GROQ_MODEL || '').trim() };
}
const groq = groqSettings();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const squash = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
// No stage means any stage (facts.js): { } and { stage: 'any' } are the same request.
const withDefaults = (intent, a) => (intent === 'list_pending_invoices' && a && !a.stage ? { ...a, stage: 'any' } : a);
// Arguments compared as the assistant compares typed text: case and punctuation ignored.
const sameArgs = (a, b) => {
  const norm = (o) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(o || {})
          .map(([k, v]) => [k, typeof v === 'string' ? squash(v) : v])
          .sort(([x], [y]) => x.localeCompare(y)),
      ),
    );
  return norm(a) === norm(b);
};
function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

const { startTestDatabase, testEnv } = await fromServer('test-support/mongo.js');
const db = await startTestDatabase();
testEnv(db.uri); // this database only, set before any server module reads its configuration

let exitCode = 0;
try {
  const { config } = await fromServer('src/config.js');
  if (config.mongoUri !== db.uri || !/\/foa_test_[^/]*$/.test(db.uri.split('?')[0])) throw new Error('Refusing to run: not connected to a throwaway test database.');
  const { route } = await fromServer('src/orchestrator/router.js');
  const { classify } = await fromServer('src/orchestrator/classify.js');
  const { resetModelPause } = await fromServer('src/orchestrator/model.js');
  const fixtures = JSON.parse(fs.readFileSync(path.join(serverDir, 'test/fixtures/orchestrator-questions.json'), 'utf8')).questions;
  const model = option('--model', groq.model || config.groqModel);

  if (!dryRun && !groq.apiKey) {
    console.error('No GROQ_API_KEY in the environment or in server/.env. Set one and run again (or use --dry-run).');
    exitCode = 2;
  } else {
    console.log(
      `Model: ${dryRun ? '(none, dry run)' : model}${effort ? `, reasoning_effort ${effort}` : ''}. ${fixtures.length} questions, ${modelOnly ? 'every one to the model' : 'router first'}.\n`,
    );
    const results = [];
    let firstCall = true;
    for (const f of fixtures) {
      const r = { id: f.id, expect: f.expect.clarify ? 'clarify' : `${f.expect.intent} ${JSON.stringify(f.expect.args)}` };
      const routed = modelOnly ? { confident: false } : route(f.question);
      if (routed.confident) {
        Object.assign(r, { by: 'rules', intent: routed.intent, args: routed.args, clarity: 'clear' });
      } else if (dryRun) {
        Object.assign(r, { by: 'model (not run)' });
      } else {
        for (let cooled = 0; ; cooled += 1) {
          if (!firstCall) await sleep(paceMs);
          firstCall = false;
          resetModelPause();
          const c = await classify(f.question, { apiKey: groq.apiKey, model, reasoningEffort: effort, previous: f.thread ? { intent: 'find_invoice', records: 1 } : null });
          Object.assign(r, { by: 'model', call: c.call, rateLimited: cooled });
          if (c.ok) Object.assign(r, { intent: c.intent, args: c.args, clarity: c.clarity, error: null });
          else Object.assign(r, { intent: null, args: null, clarity: null, error: c.code });
          if (c.code !== 'rate_limit' || cooled >= RATE_LIMIT_RETRIES) break;
          console.log(`   rate limited; waiting ${COOL_DOWN_MS / 1000} s before asking again`);
          await sleep(COOL_DOWN_MS);
        }
      }
      // Score it.
      const askedBack = r.error || r.clarity === 'unclear' || r.intent === 'unknown';
      if (r.by === 'model (not run)') r.verdict = 'not run';
      else if (f.expect.clarify) r.verdict = askedBack ? 'correct' : (f.safe || []).includes(r.intent) ? 'safe' : 'wrong without asking';
      else if (
        r.intent === f.expect.intent &&
        sameArgs(withDefaults(r.intent, r.args), withDefaults(f.expect.intent, f.expect.args)) &&
        (r.clarity === 'clear' || f.expect.intent === 'unknown')
      )
        r.verdict = 'correct';
      else if (f.expect.intent === 'unknown' && askedBack) r.verdict = 'correct';
      else r.verdict = askedBack ? 'asked back' : 'wrong without asking';
      results.push(r);
      const got = r.intent ? `${r.intent} ${JSON.stringify(r.args)}${r.clarity === 'unclear' ? ' (unclear)' : ''}` : r.error ? `error: ${r.error}` : '-';
      console.log(
        `${r.verdict.padEnd(21)} ${r.by.padEnd(6)} ${String(r.call?.ms ?? '').padStart(6)} ms  ${f.id.padEnd(18)} ${got}${r.verdict === 'correct' ? '' : `   expected ${r.expect}`}`,
      );
    }

    const run = results.filter((r) => r.verdict !== 'not run');
    const calls = results.filter((r) => r.call);
    const ms = calls.filter((r) => r.call.outcome === 'ok').map((r) => r.call.ms);
    const count = (v) => run.filter((r) => r.verdict === v).length;
    const sum = (k) => calls.reduce((n, r) => n + (r.call[k] || 0), 0);
    const figures = {
      model: dryRun ? null : model,
      reasoningEffort: effort,
      mode: modelOnly ? 'model-only' : 'router-first',
      questions: fixtures.length,
      scored: run.length,
      byRules: results.filter((r) => r.by === 'rules').length,
      byModel: calls.length,
      correct: count('correct'),
      safe: count('safe'),
      askedBack: count('asked back'),
      wrongWithoutAsking: count('wrong without asking'),
      accuracyPct: run.length ? Math.round((count('correct') / run.length) * 1000) / 10 : null,
      modelAccuracyPct: calls.length ? Math.round((calls.filter((r) => r.verdict === 'correct').length / calls.length) * 1000) / 10 : null,
      errors: calls.filter((r) => r.error).map((r) => r.error),
      rateLimitPauses: calls.reduce((n, r) => n + (r.rateLimited || 0), 0),
      latencyMs: { p50: percentile(ms, 50), p95: percentile(ms, 95) },
      tokens: { prompt: sum('promptTokens'), completion: sum('completionTokens') },
    };
    console.log(
      `\nAccuracy:             ${figures.correct}/${figures.scored} (${figures.accuracyPct}%)${calls.length ? `; model alone ${figures.modelAccuracyPct}% of ${calls.length}` : ''}`,
    );
    console.log(`Wrong without asking: ${figures.wrongWithoutAsking}`);
    console.log(`Asked back instead:   ${figures.askedBack}; safe alternatives: ${figures.safe}`);
    console.log(`Router / model:       ${figures.byRules} / ${figures.byModel}`);
    if (!dryRun) {
      console.log(`Latency (model):      p50 ${figures.latencyMs.p50} ms, p95 ${figures.latencyMs.p95} ms over ${ms.length} answered calls`);
      console.log(`Tokens:               ${figures.tokens.prompt} prompt, ${figures.tokens.completion} completion`);
      console.log(`Errors:               ${figures.errors.length ? figures.errors.join(', ') : 'none'}; rate-limit pauses ${figures.rateLimitPauses}`);
    }
    if (outFile) fs.writeFileSync(path.resolve(outFile), JSON.stringify({ ...figures, results }, null, 2));
  }
} catch (err) {
  console.error(err?.message || err);
  exitCode = 1;
} finally {
  await db.stop();
}
process.exit(exitCode);
