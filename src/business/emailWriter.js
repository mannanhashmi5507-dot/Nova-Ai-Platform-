// ─── Business Hub: Email Writer ───────────────────────────────
// Phase 9. Real, free, works today — reuses the same AI providers as
// everything else. Genuinely useful business writing help, not a fake
// "sends the email for you" feature — this drafts text; sending it is
// on the user (this app has no outbound email/SMTP integration).

const EMAIL_TYPES = {
  cold_outreach:   'a cold outreach email to a potential client/customer who has not interacted with the sender before',
  follow_up:       'a polite follow-up email referencing a previous conversation or unanswered message',
  invoice_reminder:'a professional, firm-but-polite payment reminder for an overdue or upcoming invoice',
  thank_you:       'a genuine thank-you email to a client or customer',
  proposal:        'a business proposal email introducing an offer or service to a prospective client',
  apology:         'a professional apology email addressing a mistake or service issue',
  meeting_request: 'an email requesting to schedule a meeting',
};

const VALID_TYPES = Object.keys(EMAIL_TYPES);

function buildEmailPrompt(type, brief, { recipientName, tone = 'professional', senderName } = {}) {
  const typeDescription = EMAIL_TYPES[type];
  const recipientNote = recipientName ? ` addressed to ${recipientName}` : '';
  const senderNote = senderName ? ` Sign it from ${senderName}.` : ' Leave the sign-off as [Your Name] for the user to fill in.';

  return [
    {
      role: 'system',
      content: `You write real, ready-to-send business emails. Write ${typeDescription}${recipientNote}. Tone: ${tone}. Include a clear subject line on the first line as "Subject: ...", then a blank line, then the email body.${senderNote} Do not add explanation or commentary outside the email itself.`
    },
    { role: 'user', content: `Write the email. Context/brief: ${brief}` }
  ];
}

function parseEmailResponse(reply) {
  const subjectMatch = reply.match(/^Subject:\s*(.+)$/mi);
  const subject = subjectMatch ? subjectMatch[1].trim() : null;
  const body = subjectMatch ? reply.slice(reply.indexOf(subjectMatch[0]) + subjectMatch[0].length).trim() : reply.trim();
  return { subject, body };
}

async function writeEmail(type, brief, getAIReply, signal, options = {}) {
  if (!VALID_TYPES.includes(type)) throw new Error(`type must be one of: ${VALID_TYPES.join(', ')}`);
  if (!brief || !brief.trim()) throw new Error('brief is required');

  const messages = buildEmailPrompt(type, brief, options);
  const { reply, provider } = await getAIReply(messages, 'auto', signal);
  const { subject, body } = parseEmailResponse(reply);
  return { type, subject, body, provider };
}

module.exports = { writeEmail, parseEmailResponse, VALID_TYPES };
