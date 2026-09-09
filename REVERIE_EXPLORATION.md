Reverie connected exploration — session 174
==========================================

The web World page connects its current scene to the room graph through named travel buttons and matching compass signs. The server supplies destination names, current access status, and whether an exit returns to the viewer's previous room. `orient` / Get oriented reads the room, people, exits and direct way back through the existing log, without repeating the full room description on native clients. All game clients can use the command. The agent World tool now selects the same Life engine and private gate as the page, and forwards creation choices and available actions. Both existing schema registrations name orient. The actual tool entry point is covered by the isolated-Mongo harness; no paid agent conversation is needed.

This is connected travel between existing rooms. Figure positions and the rest of the scenery remain illustrations. There are no measured player coordinates, continuous locomotion, navigation meshes, new autonomous players or changes to the private gate.

The command route accepts optional `expectedRoomId` and `expectedExit: {dir, toId}`. New connected travel controls use both; old clients remain compatible. Stale origin/destination selections return the current room without executing the requested command. Life movement conditionally changes the active character's original room before publishing departure/arrival events, so a concurrent loser cannot overwrite the winner or publish a false departure. This is not a transaction across movement, events and follower updates.

Walking checks destination existence and home access even when the source exit has no explicit lock. `back` follows an actual exit or an allowed walking route, instead of teleporting to a stored room. Autowalk cannot cross a private home whose access policy denies entry. The room projection includes only occupants in the viewer's room; adjacent occupancy is not queried or exposed by this feature.

People and the picture refresh after arrivals, departures and visible activity, on reconnection and every twenty seconds while visible. `/here` remains a read-only snapshot. A pending snapshot cannot overwrite a newer command response. Events from a previous room are discarded by the client, and the stream rechecks the character's room after fetching events. Passive updates and compose controls preserve an existing command draft.

Whisper menus now prepare quoted full names. The Life parser accepts quoted/unquoted full names and unique first names, preserves message case, and refuses ambiguous recipients. Private messages remain recipient-scoped events. No model request is needed. Public speech is still `say`, with a dedicated compose control.

Verification
------------

- `node --require ./api/test/reverie-bootstrap.cjs packages/api/src/reverie/navigation.harness.cjs`: 32 checks against disposable Mongo, including meeting/separation, private speech, locked/missing/stale exits, private shortcuts and competing moves.
- `node dev/reverie/navigation-serve.cjs`, then `node dev/reverie/navigation.cjs`: two isolated browser sessions using the actual World router, SSE and Life engine. Fake authentication exists only in this localhost development server. Production authentication is unchanged.
- Existing Washhouse, gathering, presentation and game-engine harnesses; API bundle/declaration build; strict checking of navigation.ts; client production build; helper help tests.
- Screenshots are reviewed at desktop and narrow widths. Canvas content remains hidden from screen readers. Connected travel works with graphics off and reduced motion.

The new TypeScript module passes lint. Legacy touched files retain their existing lint findings; comparison with the prior commit adds no non-formatting diagnostics. Physical VoiceOver/TalkBack, sustained battery use and human audio acceptance are separate checks. No native source or paid native build is part of this release.
