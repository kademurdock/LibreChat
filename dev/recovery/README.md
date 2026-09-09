# Account recovery checks

Run `node node_modules/jest/bin/jest.js --config api/jest.recovery.config.cjs --runInBand`.
The service suite supplies its own storage, configuration and email mocks. The
focused config omits unrelated global logging mocks, which require extra runtime
dependencies. It executes the actual AuthService with real password hashing.

After a frontend build, run `node dev/recovery/build.cjs`, then set
CHARACTER_RECEIPTS to an output directory and run `node dev/recovery/check.cjs`.
This starts a loopback server, loads the actual recovery components and actual
React Query mutations in Edge, and intercepts the HTTP responses locally. The
surrounding layout/startup data are fixtures. No email or real password is changed.

Checks cover disabled mail, failed request and retry, a malicious returned link,
missing/expired tokens, pending submissions, success and a narrow screen. The
browser check does not prove mail delivery, VoiceOver or TalkBack acceptance.

The production deployment currently has no email transport and leaves
ALLOW_PASSWORD_RESET disabled. The sign-in help link remains useful in this
configuration. Configure and test a verified sender and address recovery before
enabling email resets. Phone-only users still need administrator assistance;
knowing a phone number is not proof of ownership.

Reset tokens expire at expiresAt even before Mongo TTL cleanup. Atomic deletion
claims one token before a password write, so concurrent submissions cannot both
change the password. A database failure after consumption requires a fresh link.
Confirmation-email failure does not undo a successful change or skip the existing
controller's session invalidation. Full database and mail integration acceptance
remains required before enabling self-service recovery.
