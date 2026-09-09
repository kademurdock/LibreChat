Reverie world expansion
=======================

The Life registry exposes `explore`, `notice`, `track wildlife`, `photograph wildlife`, `field journal`, `rest by fire`, `easy fish`, `hunt`, `converse`, `reply`, and `end conversation`. The four outdoor rooms are inserted by the existing versioned city seed. Existing prose and occupied connector directions are preserved.

`outdoors.ts` supplies material, weather, background, and encounter data. The web scene consumes the same sensory profile as walking sounds. `lifeSounds.json` maps installed assets; owner-installed sound rows win over the insert-only seeder. Five material sounds and the bow cue are crafted approximations, not field recordings. The screened wood and hard-floor footfalls, creek, woods, and campfire are generated recordings. Backgrounds are quiet, mono, and use a short wrap blend; human listening acceptance has not been claimed.

Resident dialogue uses GLM 5.3 Flash through the existing server-side Reframe connection. No model runs on world ticks. Messages are limited to 600 characters, output to 220 tokens, history to six exchanges/messages per resident/player pair. The server reserves one cent before each request in the persistent `reverie_conversation_budget_153` district record, limited to 100 requests across all players and restarts. Failed or uncertain requests retain their reservation. This is a conservative $1 lifetime allowance, not a daily allowance. Do not refill it without a new spending instruction. Dialogue has no tool execution or authority to change game state. Ordinary scripted talk remains available when the provider or allowance is unavailable.

Validation with installed development dependencies:

```
node --require ./api/test/reverie-bootstrap.cjs ./packages/api/src/reverie/outdoors.harness.cjs
node --require ./api/test/reverie-bootstrap.cjs ./packages/api/src/reverie/harness.cjs
node ./api/app/clients/tools/kadegames/harness.js
```

The tests use a disposable MongoDB and explicitly replace paid HTTP for allowance checks. Production API bundle/declaration build and browser playtests are also required. Native clients get commands, choices, and event sounds from the shared API; the new illustrated scenes and background selection are web features. Keep the existing public-access gate unchanged.

Session169: `hangout invite Name` adds nearby authored resident participation with existing sounds and shared albums. See /REVERIE_3D.md for the web renderer, native hold, exact test commands and implementation limits.

Session173: the Gully Washhouse supports `sort buttons`, `repair bench`, and `book exchange`. The bench has three shared, conditionally saved repairs; stale commands cannot advance a later step. Three authored mysteries have three parts each. `read washhouse <book> <part>` advances a character's private bookmark only when it matches the requested part. `reopen washhouse` replays an already opened part without advancing; `reread washhouse` explicitly resets a finished book. Books stay at the Washhouse. Bookmarks never enter public room payloads. All new actions use existing engine choices, require no generated text, and charge no game money. Existing room prose and exits are preserved.

The public room snapshot includes only `washhouse.benchStage`. Web/Android World illustrations use it to show the repair tray while work remains, alongside linoleum, the blue tin, bench and book shelf. The exported iPhone bundle and optional decoding field are prepared on a separate native branch; they require a funded app build before native picture delivery. Existing phone command controls can receive the actions from the shared API.

The finite Part172 resident pilot still has its original expiry and twelve-request ceiling. Founder status now reports how many residents have a latest saved plan and how many of those show an emitted step; these snapshots are not lifetime counters or billing receipts. Ordinary schedules continue. This supersedes the older statement above that no model runs on world ticks: the finite planner can, within its separate persisted allowance.

Additional checks: `node --require ./api/test/reverie-bootstrap.cjs ./packages/api/src/reverie/places.harness.cjs` and `dev/reverie/washhouse.cjs` against the disposable local engine from `dev/reverie/serve.cjs`. The browser harness supports `REVERIE_PORT` and `REVERIE_RECEIPTS`. No live player is moved or given fictional conversations for these checks.
