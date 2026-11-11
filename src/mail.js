// Outbound email. Configure SMTP_URL (e.g. smtps://user:pass@smtp.resend.com:465)
// or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS. Without it, emails are skipped and
// the app surfaces signing links for the sender to share instead.
const nodemailer = require('nodemailer');

let transport = null;
if (process.env.SMTP_URL) transport = nodemailer.createTransport(process.env.SMTP_URL);
else if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: +(process.env.SMTP_PORT || 587),
    secure: +(process.env.SMTP_PORT || 587) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}
const FROM = process.env.MAIL_FROM || 'FileSign <no-reply@filesign.local>';
const enabled = () => !!transport;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(org, heading, bodyHtml, cta) {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f8;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1c23">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="font-size:13px;color:#6b7080;margin-bottom:12px">${esc(org)}</div>
    <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e4e6ec">
      <h1 style="font-size:20px;margin:0 0 14px">${esc(heading)}</h1>
      ${bodyHtml}
      ${cta ? `<p style="margin:26px 0 8px"><a href="${esc(cta.url)}" style="background:#2851c7;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${esc(cta.label)}</a></p>
      <p style="font-size:12px;color:#6b7080;word-break:break-all">Or paste this link into your browser: ${esc(cta.url)}</p>` : ''}
    </div>
    <p style="font-size:11px;color:#8a8f9c;margin-top:18px">Sent with FileSign on behalf of ${esc(org)}. If you were not expecting this, you can ignore this email.</p>
  </div></body></html>`;
}

async function send({ to, subject, html, replyTo, attachments }) {
  if (!transport) return { sent: false, reason: 'Email is not configured' };
  try {
    await transport.sendMail({ from: FROM, to, subject, html, replyTo: replyTo || undefined, attachments });
    return { sent: true };
  } catch (e) {
    console.error('mail error', e.message);
    return { sent: false, reason: e.message };
  }
}

const templates = {
  request: ({ org, clientName, docName, message, url, senderName }) => ({
    subject: `${org}: please sign your ${docName}`,
    html: layout(org, `Please review and sign: ${docName}`,
      `<p>Hi ${esc(clientName)},</p><p>${esc(senderName || org)} has sent you an agreement to review and sign electronically. It takes about two minutes and works on any device.</p>
       ${message ? `<blockquote style="border-left:3px solid #d5d9e4;margin:16px 0;padding:4px 14px;color:#444">${esc(message)}</blockquote>` : ''}`,
      { url, label: 'Review and sign' }),
  }),
  reminder: ({ org, clientName, docName, url }) => ({
    subject: `Reminder: ${docName} is waiting for your signature`,
    html: layout(org, 'Friendly reminder', `<p>Hi ${esc(clientName)},</p><p>Your ${esc(docName)} from ${esc(org)} is still waiting for your signature.</p>`, { url, label: 'Review and sign' }),
  }),
  completedSigner: ({ org, clientName, docName, url }) => ({
    subject: `Signed: ${docName}`,
    html: layout(org, 'Your agreement is signed', `<p>Hi ${esc(clientName)},</p><p>Thank you. A copy of your signed ${esc(docName)} is attached for your records.</p>`, { url, label: 'Download signed copy' }),
  }),
  completedSender: ({ org, clientName, docName, ref, url }) => ({
    subject: `Completed: ${clientName} signed ${docName} (file ${ref})`,
    html: layout(org, 'Agreement completed', `<p>${esc(clientName)} has signed the ${esc(docName)} for file <b>${esc(ref)}</b>. The signed PDF with its certificate of completion is attached.</p>`, { url, label: 'Open file' }),
  }),
  declined: ({ org, clientName, docName, ref, reason, url }) => ({
    subject: `Declined: ${clientName} declined ${docName} (file ${ref})`,
    html: layout(org, 'Agreement declined', `<p>${esc(clientName)} declined to sign the ${esc(docName)} for file <b>${esc(ref)}</b>.</p><p><b>Reason:</b> ${esc(reason || 'No reason given')}</p>`, { url, label: 'Open file' }),
  }),
};

module.exports = { send, enabled, templates };
