# Clubhouse clients

`kadeLounge.js` owns authenticated HTTP routes and exports the two public HTML
handlers. `pages.js` assembles these assets once per server process; the handlers
still send `Cache-Control: no-store`. The scripts remain inline, so this split adds
no requests and requires no client bundler.

- `lounge.html` and `lounge.js`: browser room controls, roster, jukebox, guest and
  recording.
- `engine.html` and `engine.js`: the native app's hidden WebKit participant.
  It publishes music and guest audio, captures guest ears and records the room.
- Native counterparts: `ClubhouseEngine.swift` transports commands/events;
  `ClubhouseService.swift` owns room state and dispatches them.

The native app supplies LiveKit and API tokens in the URL fragment; the engine
scrubs the fragment on startup. Never log or move these tokens to query strings.
Song data enters through `KE.feedB64`; `KE.loadPlay` starts it. `playing`, `pos`,
`halted`, `ended`, `need`, `feedfail` and `playfail` events report playback state.
`botOn`, `botSay`, `botOff`, `earsOn` and `earsOff` control the guest. Recording
uses `recOn`/`recOff` and `recon`/`recb`/`recdone`/`recfail` events.

Check the **rendered** scripts with:

    node --test api/server/routes/Clubhouse/pages.test.js

Checking only the route module did not catch newline escapes becoming literal
newlines inside browser string literals. This regression affected both clients.
Changes to Swift's event switch must remain compatible with installed older apps.
