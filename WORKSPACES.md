# Computer workspaces

The existing Kade-AI server now has a durable account-owned queue for paired Windows workers. A phone or Windows client creates the same project, session and run records. The worker opens an outbound HTTPS connection; the server does not need an inbound port on the computer or another hosted service.

The registry is separate from ordinary chat task receipts and existing admin-only harness history. An optional `chatProjectId` links an existing owned ChatProject. Its existing instructions and document context remain in their existing store. This queue does not claim to migrate older harness jobs or automatically load ChatProject files into a coding runtime.

## Authentication and ownership

All normal routes use the platform's existing `requireJwtAuth`. Account and tenant identity always come from that middleware. Caller-supplied owner fields are rejected. Worker tokens authorize only `/worker/poll` and `/worker/runs/:id/events` and are bound to one device and its owner/tenant.

Device registration returns a random `kw_` token once. Only its SHA-256 hash is stored by the server. Retrying an identical registration request returns the same device and `workerToken: null`; explicit account-authenticated token rotation recovers a lost response. Rotation interrupts active work. Revoking a device interrupts its queued/active work, rejects its token and retains receipts.

## Routes

Prefix: `/api/kade/workspaces`. Successful JSON responses use HTTP 200. Identifiers and `requestId` values contain 8–128 letters, digits, underscores or hyphens. Create requests are idempotent by owner, entity kind and request ID; reusing one for different content returns 409.

| Method and suffix | Body or query | Response |
| --- | --- | --- |
| `POST /devices` | `{requestId,name,platform,capabilities}` | `{device,workerToken}` |
| `GET /devices` | optional `before=id` | `{devices,nextCursor}` |
| `POST /devices/:id/update` | `{capabilities,name?}` | `{device}` |
| `POST /devices/:id/token` | `{}` | `{device,workerToken}` |
| `POST /devices/:id/revoke` | `{}` | `{device}` |
| `POST /projects` | `{requestId,name,deviceId,workspaceKey,allowEdits?,chatProjectId?}` | `{project}` |
| `GET /projects` | optional `before=id` | `{projects,nextCursor}` |
| `POST /sessions` | `{requestId,projectId,title,runtime,model?}` | `{session}` |
| `GET /sessions` | optional `projectId`, `before=id` | `{sessions,nextCursor}` |
| `POST /runs` | `{requestId,sessionId,prompt,mode?}` | `{run}` |
| `GET /runs` | optional `before=id` | `{runs,nextCursor}` |
| `GET /runs/:id` | — | `{run}` |
| `GET /runs/:id/events` | optional numeric `after=sequence` | `{events,nextCursor}` |
| `POST /runs/:id/stop` | `{}` | `{run}` |
| `POST /seen` | `{kind:"run",id,throughSequence}` | `{seen:{kind,id,throughSequence}}` |
| `GET /read-state` | — | `{readState:{alerts,announcements,agentWork}}` |
| `POST /read-state` | `{kind,seenThrough:ISO}` | `{readState}` |
| `POST /worker/poll` | `{workerInstanceId}` | `{run:null\|WorkerRun,stopRequested}` |
| `POST /worker/runs/:id/events` | `{workerInstanceId,leaseId,events}` | `{run,accepted:[eventId],nextCursor}` |

Device platforms: `windows`, `ios`, `android`. Runtime identifiers/capabilities: `inspect`, `codex`, `claude`, `custom`. Advertising a capability is not proof of installed or sandboxed execution; the worker independently discovers adapters and enforces its local grants. A job is refused if its device has not advertised the selected runtime. `inspect` is a built-in folder inventory and cannot accept edit jobs. No inference is performed by these server routes.

An explicit Enable can refresh a device's locally discovered capabilities and optional name through `/devices/:id/update`. Newly installed runtimes can then be selected without re-pairing. Removing an active runtime interrupts its current job; it does not undo completed work.

Project `workspaceKey` is an opaque identifier mapped to a directory only in the Windows worker's local encrypted journal. Remote callers cannot provide shell commands, executable paths or local runtime resume identifiers through this protocol. `allowEdits` defaults to false. Editing requires both this server grant and an independent local worker grant. Re-registering an identical folder returns its existing project; changing its permission requires a new locally registered workspace key.

Names/titles allow 1–120 characters; prompts 1–32,000; optional model identifiers 1–160. Projects, sessions and devices return at most 100 entries; runs return 50; event pages return at most 200 entries and about 1 MiB. Lists sort by creation time and ID and return `nextCursor`; clients must expose or follow later pages. Session queries preserve their `projectId` filter across pages. Lists/status exclude saved event journals, and running-worker heartbeats update only lease metadata, avoiding repeated journal downloads and rewrites.

Event inputs are `{eventId,type,text?,state?,data?}`. `type` is `status`, `message`, `tool` or `result`; state, when supplied, is `running`, `done`, `failed`, `stopped` or `interrupted`. `data` is a string-to-string map (keys at most 80 characters, values 8,000). Text is at most 64,000 characters. A batch contains 1–50 events and the request body is at most 1 MiB. Event IDs beginning `srv_` are reserved. A result without a state does not settle a run; a terminal status can follow it in the same batch. Terminal state must be the last new event; retries of already accepted events remain safe.

The server assigns event sequences and timestamps. Exact event-ID retries deduplicate; changed content with the same ID returns 409. A run stores at most 2,000 ordinary events or 8 MiB of event data; exceeding this cap atomically interrupts the job, retains one small terminal receipt, releases its active slot and returns 413 with the terminal `run`. The worker must stop on a permanent lease/event refusal, retain its local evidence and continue polling so a failed outbox cannot block Stop.

## Recovery and stopping

MongoDB persists devices, projects, sessions, run events and read cursors. Unique partial indexes permit one queued/running/stopping job per device and workspace. Optimistic revisions protect concurrent event delivery, stopping and read acknowledgements. Starting work fails if its durable record cannot be saved.

Each Windows worker process generates a fresh `workerInstanceId`. A claimed run returns a random `leaseId`; both must accompany event delivery. Repeated polling from the same instance returns its existing run. A different worker process finding an unfinished run interrupts it instead of starting it again. No contact for 90 seconds also interrupts work when the next status, list or worker request checks it. A server process restart preserves a still-live worker's lease; it never starts commands itself.

A queued Stop settles immediately without handing work to the computer. A running Stop persists `stopping`; the next worker poll returns `stopRequested: true`. Completed commands and file changes remain. After an interruption, the user reviews local receipts and explicitly creates another job; the queue never automatically retries an uncertain command.

Per-run seen sequences are monotonic and capped at the last saved event. Account read cursors are separate from delivery, completion and required attention. Read timestamps are monotonic, owner/tenant scoped, normalized to UTC and capped at server time. Marking a failed job read does not claim the failure was resolved.

## Verification and release state

`packages/api/src/workspaces/service.spec.ts` exercises real MongoDB through `mongodb-memory-server`, including HTTP validation/auth boundaries, owner/tenant isolation, creation races, event replay, process/server restart, Stop, revocation, token rotation, storage limits, concurrent read acknowledgements, edit/runtime grants and pagination. With the normal repository dependencies built, run from `packages/api`:

```powershell
npx jest src/workspaces/service.spec.ts src/workspaces/controller.spec.ts --runInBand --coverage=false
```

The October 22 local verification passed the complete production `npm run frontend` chain after a locked `npm ci` in an isolated Windows worktree: data provider, database schemas, API declarations, shared client, and Vite/PWA frontend. Explicit exported service and collection interfaces allow the production declaration build to resolve the new packages. Targeted repository ESLint and all 16 tests in the two workspace suites also passed against those built packages. After the Dockerfile's production dependency prune, the API, schema and telemetry imports still resolved. Verification did not call a model, a production database, an external account or a deployment endpoint. Linux container and live account/iPhone/Windows-to-production checks remain separate release checks. These changes are prepared source, not a claim that the deployed server already has these endpoints.

The optional `controller.spec.ts` smoke test also runs the real Python Windows worker against this Express router and a fresh MongoMemoryServer, with synthetic files, a temporary DPAPI journal, and loopback-only HTTP transport. It runs on Windows when the sibling Windows fixture checkout is available, or with `KADE_WORKER_SMOKE_FIXTURE` and `KADE_WORKER_TEST_PYTHON` set to trusted local test paths. It skips when that independent fixture is absent so a standalone backend checkout remains testable. The local run exposed and verified a Windows directory identity fix in the worker; it does not replace NVDA/VoiceOver or production account testing.
