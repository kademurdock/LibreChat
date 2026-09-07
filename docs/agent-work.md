# Agent work request receipts

`/agent-work` lists new two-phase agent chat requests for the signed-in
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
`streamAvailable` is true only when the current job has the same request ID and
creation time. A caller recovering an uncertain POST should check the exact
receipt before sending again. `/agent-work?requestId=...` opens only that receipt;
it never falls back to another request if it is missing.
Reply saved means a reply was persisted, not proof an external action succeeded.
An absent stream without a confirmed finished reply means interrupted.

An ordinary two-phase POST uses requestId, falling back to messageId, as its
idempotency identifier. A MongoDB `_id` atomically claims it within the owner and
tenant. The same identifier and fingerprint return the existing conversation;
changed input with the same identifier receives 409. Clients must retain that
identifier to benefit: Retry buttons that create a new ID remain new requests.
Regenerate/continue/edit calls require an explicit fresh requestId to opt in.
The web client now supplies one per logical submission for all these operations.
Transport retries retain it, including an effect remount of the same submission.
Network failures, timeouts and uncertain server errors trigger a paced read of
the exact receipt. An existing stream resumes with `?resume=true&taskId=...`;
the server rejects a different request in the same conversation. Only a 404
receipt permits bounded automatic POST retries with the same ID. If checking
fails or the stream has expired, the error offers **Check this request** rather
than Regenerate. A deliberate new generation still gets a fresh ID.
These IDs are not yet persisted across browser reloads; requests already claimed
on the server remain in Agent work. Native Retry and separate voice/harness lanes
retain their previous behavior. This is not a cross-client durable send queue.
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

Additional free checks: `node --test api/test/narration.recovery.test.cjs` exercises
the studio agent's status reporting through an HTTP fixture boundary; it makes
no audio. Client Jest tests for `useResumableSSE` cover lost responses, bounded
same-ID retries, failed lookups, expired streams, remounts and navigation.
The API `src/tools/definitions.spec.ts` suite exercises the actual definition-only
loader used by production agents, including narration actions, job identity and
audio controls. Studio schemas and narration instructions live together in
`packages/api/src/tools/registry/fal.ts`, shared with the executing `FalAI` tool;
updating only a constructor description would not update production agent binding.
`node --test api/server/services/kadeToolRetrieval.test.js` checks narration,
song rendering, sound effects and audio editing against missed embedding matches;
writing lyrics alone does not select the rendering tool through these aliases.
These free checks establish the binding and tool behavior, not model output quality.
