// Where a payment notice to a supplier actually goes. Decided only by server
// settings, never by anything the dashboard sends.
//
//   live              only when APP_ENV=production AND SUPPLIER_EMAIL_MODE=live
//                     (and an email service is configured): to the supplier
//   test_recipient    otherwise, when TEST_EMAIL_RECIPIENT and an email service
//                     are set: to the test recipient, marked as a test, with the
//                     supplier's address only in the text
//   simulated_outbox  otherwise: nothing is sent; the message stays in the outbox
//
// Outside production a supplier can never receive anything.

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export function deliveryMode({ appEnv, mode, testRecipient, mailer }) {
  if (appEnv === 'production' && mode === 'live' && mailer) return 'live';
  if (testRecipient && mailer) return 'test_recipient';
  return 'simulated_outbox';
}

export function createEmailDelivery({ appEnv = 'development', mode = 'outbox', testRecipient = '', mailer = null } = {}) {
  const current = deliveryMode({ appEnv, mode, testRecipient, mailer });
  return {
    mode: current,
    describe: () => ({
      mode: current,
      appEnv,
      // The test address is shown to administrators so they know where test mail goes.
      testRecipient: current === 'test_recipient' ? testRecipient : null,
      note:
        current === 'live'
          ? 'Production: notices are emailed to suppliers.'
          : current === 'test_recipient'
            ? 'Not production: notices go to the test recipient only.'
            : 'Not production (or no email service): notices stay in the simulated outbox. Nothing is emailed.',
    }),

    /** Deliver one message. Returns { mode, intendedTo, deliveredTo, redirected, id, at }. */
    async deliver({ to, subject, text }) {
      const at = new Date().toISOString();
      if (current === 'live') {
        const r = await mailer.send({ to: [to], subject, text, html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(text)}</pre>` });
        return { mode: current, intendedTo: to, deliveredTo: to, redirected: false, id: r?.id ?? null, at };
      }
      if (current === 'test_recipient') {
        const body = `TEST MESSAGE. In production this would have gone to ${to}.\n\n${text}`;
        const r = await mailer.send({
          to: [testRecipient],
          subject: `[TEST, for ${to}] ${subject}`,
          text: body,
          html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(body)}</pre>`,
        });
        return { mode: current, intendedTo: to, deliveredTo: testRecipient, redirected: true, id: r?.id ?? null, at };
      }
      return { mode: current, intendedTo: to, deliveredTo: null, redirected: true, id: null, at };
    },
  };
}
