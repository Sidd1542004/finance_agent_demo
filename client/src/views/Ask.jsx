import { useState } from 'react';
import { api } from '../api.js';
import { AskAnswer } from '../askAnswer.js';

// Ask a question about the records (POST /api/orchestrator/ask). Read-only:
// the assistant answers from the records and never changes anything. The
// conversation is kept for this browser session, so a follow-up such as
// "why is this invoice on hold?" knows which invoice. The server keeps only
// what was asked and which records it showed, for 24 hours, for this person.

const THREAD_KEY = 'foa.ask.thread';
const ENDED = /conversation has ended/;
const readThread = () => {
  try {
    return sessionStorage.getItem(THREAD_KEY);
  } catch {
    return null;
  }
};
const writeThread = (id) => {
  try {
    if (id) sessionStorage.setItem(THREAD_KEY, id);
    else sessionStorage.removeItem(THREAD_KEY);
  } catch {
    /* storage unavailable: the conversation lasts as long as this screen */
  }
};

export default function AskView({ onError, openInvoice }) {
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState('');
  const [response, setResponse] = useState(null);
  const [busy, setBusy] = useState(false);

  const send = async (body) => {
    setBusy(true);
    onError(null);
    try {
      const threadId = readThread();
      let r;
      try {
        r = await api.ask({ ...body, ...(threadId ? { threadId } : {}) });
      } catch (err) {
        // The conversation ended (24 h), or belongs to whoever signed in here before: start a new one.
        if (!threadId || body.choice || !ENDED.test(err.message)) throw err;
        writeThread(null);
        r = await api.ask(body);
      }
      writeThread(r.threadId);
      setResponse(r);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setAsked(q);
    setQuestion('');
    send({ question: q });
  };

  return (
    <div className="ask-layout">
      <section className="panel ask-panel" aria-labelledby="ask-head">
        <h2 id="ask-head">Ask</h2>
        <p className="hint">Ask about invoices, payments, suppliers, bank lines or mailbox ingestion. Answers come from the records, and nothing is changed.</p>
        <form className="ask-form" onSubmit={submit}>
          <label className="field-label" htmlFor="ask-q">
            Your question
          </label>
          <textarea id="ask-q" value={question} maxLength={500} rows={2} placeholder="Why is SCP-7731 not paid yet?" onChange={(e) => setQuestion(e.target.value)} />
          <button className="btn btn-primary" type="submit" disabled={busy || !question.trim()}>
            {busy ? 'Asking…' : 'Send'}
          </button>
        </form>
        {asked && <p className="ask-question">{asked}</p>}
        <AskAnswer response={response} disabled={busy} onChoose={(optionId) => send({ choice: optionId })} onOpenInvoice={openInvoice} />
      </section>
    </div>
  );
}
