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
