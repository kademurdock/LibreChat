# Agent work request receipts

`/agent-work` lists new ordinary two-phase agent chat requests for the signed-in
user. Refresh and opening a saved conversation never resubmit the message.
It works in mobile browsers and desktop browsers; native requests use the same
server receipts. The native inbox is being prepared separately.

## API and Forge access

Authenticated `GET /api/agents/chat/tasks` returns up to 20 receipts and
`nextCursor`. Pass it as `?before=...` for older rows. `GET /api/agents/chat/tasks/:taskId`
checks one request. Both require the caller's existing LibreChat JWT and scope
by authenticated user and tenant, never a query-string user ID. Forge can use
this documented REST API through his existing authenticated development access;
no new built-in model tool or admin cross-user endpoint is added.

Each item includes taskId, conversationId, title, status, createdAt, updatedAt,
canOpenConversation and an optional responseMessageId. All responses are no-store.
Reply saved means a reply was persisted, not proof an external action succeeded.
An absent stream without a confirmed finished reply means interrupted.

An ordinary two-phase POST uses requestId, falling back to messageId, as its
idempotency identifier. A MongoDB `_id` atomically claims it within the owner and
tenant. The same identifier and fingerprint return the existing conversation;
changed input with the same identifier receives 409. Clients must retain that
identifier to benefit: Retry buttons that create a new ID remain new requests.
Regenerate/continue/edit calls require an explicit fresh requestId to opt in.
No external side-effect exactly-once guarantee or restart worker is introduced.

Stop stays scoped to the supplied conversation/stream. A missing explicit stream
returns 404; without an identifier, fallback is allowed only for one active chat.
Several active chats return 409. Stopping never undoes already-performed actions.

Receipts hold opaque IDs, a SHA-256 input fingerprint and state, with no duplicate
prompts, replies, titles or attachments. Titles/links are read from owned chats.
Temporary receipts are excluded from lists and have a 24-hour MongoDB TTL index.
Deleting a chat tombstones its receipts, removing chat/message links while keeping
the duplicate guard. Account deletion removes that owner's receipts. Existing
conversations are not backfilled: historical request identifiers and outcomes
cannot be safely inferred from a saved transcript alone.

## Verification

After `npm ci` and `npm run build:packages`:

- `npm run test:kade-tasks` uses a temporary real MongoDB and the real controller,
  router and generation manager. Model execution and authentication are fixture
  boundaries; no paid model calls are made. `MONGOMS_SYSTEM_BINARY` can point to an
  already-installed mongod to avoid the initial download.
- `node e2e/tasks.browser.cjs` checks Chromium and WebKit against local HTTP
  fixtures. Install Playwright's matching browsers first. Optional
  `KADE_PLAYWRIGHT_MODULE` selects an existing compatible Playwright installation.
- Existing resume metadata, abort, tenant-stream, conversation and user deletion
  suites cover compatibility. `npm run frontend` includes production asset copying.

Browser checks include pagination focus, a live status region, escaped titles,
offline list retention, expired login, 403 stop, no polling, light/dark layouts at
320/390/1280 pixels and normal/double text. WebKit's default keyboard mode skips
links, so the skip-link activation check starts with explicit focus there.
These checks do not replace physical VoiceOver, TalkBack or NVDA acceptance.
