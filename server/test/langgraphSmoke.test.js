// Smoke test for the pinned LangGraph.js packages (docs/agentic-analysis.md
// §10). Nothing in the app imports them yet. This checks what the design
// relies on, against the pinned versions:
//   - a graph with interrupt() and Command({ resume }) runs and resumes;
//   - on resume the interrupted node runs again from its start, so side
//     effects must live in a separate node (§10.2);
//   - MongoDBSaver works with mongoose's own client, in the default
//     collections, and a new saver (a later request) resumes from it.

import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from '@langchain/langgraph';
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import { startTestDatabase } from '../test-support/mongo.js';

const db = await startTestDatabase();
await mongoose.connect(db.uri);
test.after(() => db.stop());

// receive -> await_person (interrupt) -> act -> END, counting each node's runs.
function approvalGraph(checkpointer) {
  const runs = { receive: 0, await_person: 0, act: 0 };
  const State = Annotation.Root({
    goal: Annotation(),
    decision: Annotation(),
    acted: Annotation(),
  });
  const graph = new StateGraph(State)
    .addNode('receive', () => {
      runs.receive += 1;
      return {};
    })
    .addNode('await_person', (state) => {
      runs.await_person += 1;
      const answer = interrupt({ proposal: `do ${state.goal}` });
      return { decision: answer.decision };
    })
    .addNode('act', (state) => {
      runs.act += 1;
      return { acted: state.decision === 'approve' };
    })
    .addEdge(START, 'receive')
    .addEdge('receive', 'await_person')
    .addEdge('await_person', 'act')
    .addEdge('act', END)
    .compile({ checkpointer });
  return { graph, runs };
}

const interruptsOf = async (graph, config) => (await graph.getState(config)).tasks.flatMap((t) => t.interrupts.map((i) => i.value));

test('interrupt and resume, in memory; the interrupted node runs again on resume', async () => {
  const { graph, runs } = approvalGraph(new MemorySaver());
  const config = { configurable: { thread_id: 'run-memory' } };
  await graph.invoke({ goal: 'link PO' }, config);
  assert.deepEqual(await interruptsOf(graph, config), [{ proposal: 'do link PO' }]);
  assert.deepEqual(runs, { receive: 1, await_person: 1, act: 0 }, 'nothing acts before a person answers');

  const final = await graph.invoke(new Command({ resume: { decision: 'approve' } }), config);
  assert.equal(final.acted, true);
  assert.deepEqual(runs, { receive: 1, await_person: 2, act: 1 });
});

test("MongoDBSaver on mongoose's client: default collections, and a later request resumes", async () => {
  const client = mongoose.connection.getClient();
  const dbName = mongoose.connection.db.databaseName;
  const first = new MongoDBSaver({ client, dbName });
  assert.deepEqual(await first.setup(), [], 'indexes created');
  const config = { configurable: { thread_id: 'run-mongo' } };

  const a = approvalGraph(first);
  await a.graph.invoke({ goal: 'approve INV-1' }, config);
  assert.deepEqual(a.runs.act, 0);
  const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
  for (const n of ['checkpoints', 'checkpoint_writes']) assert.ok(names.includes(n), n);

  // A new request: a new saver and graph, the same thread.
  const b = approvalGraph(new MongoDBSaver({ client, dbName }));
  assert.deepEqual(await interruptsOf(b.graph, config), [{ proposal: 'do approve INV-1' }]);
  const final = await b.graph.invoke(new Command({ resume: { decision: 'reject' } }), config);
  assert.equal(final.acted, false);
  assert.deepEqual(b.runs, { receive: 0, await_person: 1, act: 1 });

  // Cleanup for a finished run.
  await first.deleteThread('run-mongo');
  assert.equal(await mongoose.connection.db.collection('checkpoints').countDocuments({ thread_id: 'run-mongo' }), 0);
  assert.equal(await mongoose.connection.db.collection('checkpoint_writes').countDocuments({ thread_id: 'run-mongo' }), 0);
});
