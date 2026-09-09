export type ApprovalEmailStatus =
  | 'accepted'
  | 'sending'
  | 'unconfirmed'
  | 'unavailable'
  | 'phone-only';

interface ApprovalEmailDependencies {
  configured: boolean;
  claim: () => Promise<boolean>;
  previousStatus: () => Promise<ApprovalEmailStatus>;
  send: () => Promise<void>;
  record: (status: ApprovalEmailStatus) => Promise<void>;
}

/** Account creation survives mail failure. Uncertain sends are never repeated automatically. */
export async function deliverApprovalEmail(
  email: string,
  dependencies: ApprovalEmailDependencies,
): Promise<ApprovalEmailStatus> {
  if (!email || email.toLowerCase().endsWith('.invalid')) return 'phone-only';
  if (!dependencies.configured) return 'unavailable';
  try {
    if (!(await dependencies.claim())) return await dependencies.previousStatus();
  } catch {
    // No send was attempted. Preserve the successful account creation and manual fallback.
    return 'unavailable';
  }
  try {
    await dependencies.send();
    await dependencies.record('accepted');
    return 'accepted';
  } catch {
    await dependencies.record('unconfirmed').catch(() => undefined);
    return 'unconfirmed';
  }
}

export function approvalEmailNotice(status: ApprovalEmailStatus, email: string): string {
  switch (status) {
    case 'accepted':
      return `Account information was sent to ${email}. The email service accepted it for delivery.`;
    case 'sending':
      return 'The account email is being sent. It has not been sent again.';
    case 'unconfirmed':
      return 'The account is ready, but email delivery could not be confirmed. Share the sign-in message below, or help them reset their password. No second email was sent automatically.';
    case 'phone-only':
      return 'This account uses a phone number and has no email address. Share the sign-in message below.';
    case 'unavailable':
      return 'Account email is unavailable. Share the sign-in message below.';
  }
}
