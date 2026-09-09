# Account email

Account verification, verification resend, password reset and password-change confirmation use the existing templates through the Resend HTTPS transport. `kademurdock.com` was verified with Resend on September 9, 2026. The Railway domain's original website records were preserved; only the provider-generated DKIM TXT and `rsend`/`send` CNAME records were added. Sending is enabled, receiving is disabled, and click/open tracking is off.

## Configuration

The LibreChat Railway service holds a sending-only `RESEND_API_KEY`. The temporary full-access setup key is not installed in the app. Sender: `Kade-AI <accounts@kademurdock.com>`. Replies go to `kademurdock@gmail.com` through `EMAIL_REPLY_TO`; this is not a hosted inbox or forwarding service. `DOMAIN_CLIENT` and `DOMAIN_SERVER` are both `https://kademurdock.com`.

`checkEmailConfig()` is shared by the account service and public startup configuration, so the signup and recovery screens recognize Resend. `ALLOW_PASSWORD_RESET=true` enables the reset routes. New registrations receive verification email; existing verified accounts are not changed. Phone-only accounts, lost inboxes and lost two-factor codes still need Kade's assistance. Never run a bulk welcome or retroactive verification campaign.

The free transactional plan allows 3,000 emails/month and 100/day. No paid plan was selected. Quota failures must report delivery failure rather than claim an email was sent. [Resend quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits).

## Delivery and recovery

`packages/api/src/utils/resend.ts` uses a 15-second timeout, no redirects, a stable idempotency key for the rendered email and a required provider acceptance ID. Uncertain sends are not retried automatically. Exceptions omit credentials, recipients and reset URLs. SMTP and Mailgun remain available when Resend is absent.

Reset links use the public HTTPS domain and expire after 15 minutes. Exact token consumption prevents replay, and successful reset invalidates sessions. Reset request responses do not expose links or reveal whether an account exists. Confirmation-delivery failure does not undo an already completed password change. Invalid verification links offer resend immediately; failed resends can be retried.

## Rollout acceptance

First verify the domain and a delivery to Kade's own inbox using the sending-only key. Stage the sender with reset disabled, then validate signup, delivered verification/resend and token consumption on a new disposable account addressed to a unique Gmail plus-alias owned by Kade. Enable reset after that readiness check, verify the live reset/change-confirmation path, log in once with the new synthetic password, then delete that test account. Never reset a real user's password for testing.

Use the Railway deployments query to confirm the exact commit is SUCCESS and `/api/config` to confirm `emailEnabled` and `passwordResetEnabled`. Resend's `delivered` event confirms recipient-server acceptance, not inbox placement or a human read. Persist only sanitized IDs/statuses; do not save mail HTML, reset links, passwords or API keys. The September 9 Part170 report in the project information folder holds the final acceptance and deployment receipts. Unit tests cover expiry and failure paths; distinguish those from actual live delivery checks.
