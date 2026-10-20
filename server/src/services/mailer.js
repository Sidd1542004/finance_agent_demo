// Sending email, for the daily summary. Resend's HTTP API when RESEND_API_KEY
// is set, otherwise SMTP (nodemailer) when SMTP_HOST is set, otherwise nothing.
// Keys and passwords are never logged or returned.

const RESEND_URL = 'https://api.resend.com/emails';

export function createMailer({ resendApiKey, smtp = {}, from }, { fetchImpl = fetch, loadNodemailer = () => import('nodemailer') } = {}) {
  if (resendApiKey) {
    return {
      via: 'resend',
      async send({ to, subject, html, text }) {
        let res;
        try {
          res = await fetchImpl(RESEND_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to, subject, html, text }),
            signal: AbortSignal.timeout(15000),
          });
        } catch (err) {
          throw new Error(`Could not reach Resend (${err?.name === 'TimeoutError' ? 'timed out' : err?.message || 'network error'}).`);
        }
        let data = null;
        try {
          data = await res.json();
        } catch {
          /* not JSON */
        }
        if (!res.ok)
          throw new Error(
            res.status === 401 || res.status === 403
              ? `Resend refused the request (${res.status}). Check RESEND_API_KEY and that ALERT_FROM uses a verified domain.`
              : `Resend returned an error (${res.status})${data?.message ? `: ${data.message}` : '.'}`,
          );
        return { id: data?.id ?? null };
      },
    };
  }
  if (smtp.host) {
    return {
      via: 'smtp',
      async send({ to, subject, html, text }) {
        const { default: nodemailer } = await loadNodemailer();
        const transport = nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
          connectionTimeout: 15000,
        });
        const info = await transport.sendMail({ from, to: to.join(', '), subject, html, text });
        return { id: info?.messageId ?? null };
      },
    };
  }
  return null;
}
