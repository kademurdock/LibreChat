import { createHash } from 'node:crypto';

interface AccountEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}

/** Bounded transactional delivery. Never put credentials or reset links in errors. */
export async function sendAccountEmail(message: AccountEmail): Promise<{ id: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key || !message.from || !message.to) throw new Error('Account email is not configured');
  const body = JSON.stringify({
    from: message.from,
    to: [message.to],
    subject: message.subject,
    html: message.html,
    ...(message.replyTo ? { reply_to: message.replyTo } : {}),
  });
  const idempotency = createHash('sha256').update(body).digest('hex');
  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `account/${idempotency}`,
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('Account email delivery could not be confirmed');
  }
  if (!response.ok) throw new Error(`Account email provider refused delivery (${response.status})`);
  try {
    const data: { id?: string } = await response.json();
    if (typeof data.id === 'string' && data.id.length > 0 && data.id.length <= 100)
      return { id: data.id };
  } catch {
    // A successful HTTP response alone is not a provider acceptance receipt.
  }
  throw new Error('Account email provider returned no delivery receipt');
}
