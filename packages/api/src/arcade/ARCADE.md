# The Arcade (server side)

Added Oct 18 2026. The Arcade lets the Kade AI app play games on the phone from packs of game
files. This router (`router.ts`) is the server's whole part: it lists the games, says who may play
each one, and gives out one-hour signed download links. Game files never pass through the server,
and none of them belong in this repository, `client/public`, the app bundle or CI.

Wiring: `api/server/routes/kadeArcade.js` (bucket, the Library's `signGet` and `isChild`, the
shared rate limiters, logger), mounted at `/api/kade/arcade` in `api/server/index.js` before the
`/api/kade` catch-all. Tests: `router.test.ts` here and `../family/pack.test.ts`.

## Who plays what

- A catalog entry with `"access": "public"` is open to every signed-in account, the App Review
  seats included.
- Anything else is on the **family shelf**. The family shelf is the Family feature pack's
  `arcadeFamily` (`../family/pack.ts`): admins always, the App Review seats never, the Library's
  family permission otherwise. Kade turns it on and off with the Library switch she already has.
- Outside the pack, `GET /config` shows the family games as **one** greyed entry,
  `{ id: 'family-shelf', title: 'Family shelf', locked: true, note: 'Part of the Family feature pack' }`,
  with no game names. The manifest and pack routes check the pack again on the server and refuse
  with `FAMILY_PACK_ARCADE_REFUSAL`: "This game is on the family shelf. Ask Kade for the Family
  feature pack to play it." An unknown id gets the same refusal outside the pack, so the routes
  never reveal which family games exist.
- **Child accounts** (the Library's `isChild`: `kadeAccountType` `'child'`, and an account that
  cannot be read counts as a child). A catalog row with `"grownUpsOnly": true` is absent for a
  child, as a grown-ups-only Library book is: `/config` leaves it out (it is not folded into the
  shelf), and the manifest and pack routes answer exactly as for an id that is not in the catalog
  (404 inside the pack, the family refusal outside it), before any `pack.json` is read. A row
  without the flag is open to children; whether a game carries it is Kade's call, row by row.

## Routes

Every route needs sign-in (`requireJwtAuth`, a Bearer header) and answers `Cache-Control: no-store`.
The manifest and pack routes (`/games/...` and `/kit/...`) allow 60 requests a minute per account
(a shared limiter); `/config` reads only the cached catalog and is not limited.

| Route | Answer |
| --- | --- |
| `GET /config` | `{ catalog: [{ id, title, console, access, version, size, locked, note? }], features, familyPack, note, kit: { version, size } \| null }`. `features` is the person's whole pack map, `arcadeFamily` included. |
| `GET /games/:id/manifest` | `{ id, title, console, access, version, ready, packs, entry?, emulatorData? }`. `packs` is `[kitPack, gamePack]`, each `{ kind: 'kit' \| 'game', id, version, size, sha256, signPath, files: [{ path, offset, size, mime?, sha256? }] }`: `size` and `sha256` are `blob.bin`'s, `files` is the checked file table from that pack's `pack.json`, and `signPath` (for example `/api/kade/arcade/kit/4.2.3-1/pack`) answers the pack's signed link. The kit pack's id is always `kit`. Until both `pack.json` files are uploaded and pass the checks below, `ready` is false and `packs` is `[]`, so the phone never installs a game without its kit. `entry` (the game page) and `emulatorData` (EmulatorJS's folder in the kit) appear only when the packs name them; otherwise the app's defaults hold (`games/<id>/play.html`, `emulator/`). 403 with the refusal outside the pack for a family game. |
| `GET /games/:id/:ver/pack` | `{ url, sha256, size, version, expiresIn: 3600 }`. `url` is a signed GET for exactly `blob.bin` of that version, good for one hour. `sha256` and `size` come from that version's `pack.json`. 404 until `pack.json` exists and passes the checks. Any uploaded version signs, so a resumed download can finish. |
| `GET /kit/:ver/manifest` | `{ kind: 'kit', id: 'kit', version, size, sha256, signPath, files, ready: true, emulatorData? }` (the same pack shape as in a game manifest) for every signed-in account. |
| `GET /kit/:ver/pack` | Same shape as a game pack, for every signed-in account (the kit is open-source code). |
| `POST /diag` | Body `{ kind, game?, version?, stats? }`, at most 4 KB, 30 a minute per account (a report every five seconds is 12). `kind` must be one of the listed kinds below, or the answer is 400. Kept: `kind`, a valid game id and version, and only the listed `stats`, each checked for its type; a string stat is kept only when it is one of its listed words or matches its fixed pattern. Any other stat name, and any other string, is dropped, so no field can carry free text. Logged as `[arcade/diag]` with the account id and nothing else about the person. Answers 204. |

`:id` must match `^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$`, and `:ver` must match
`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,30}[A-Za-z0-9])?$` with no `..`. Anything else is a 404 before
any storage key is built.

### Diagnostics the server keeps

- Kinds: `boot`, `tick`, `soak`, `telemetry`, `mode`, `audio`, `saved`, `download`, `install`,
  `start`, `pause`, `resume`, `exit`, `reload`, `terminated`, `recovered`, `crash`, `error`.
- Number stats: `loads`, `uptime`, `heap`, `heapMax`, `fps`, `fpsMin`, `frames`, `opus`, `flac`,
  `clips`, `clipBytes`, `contexts`, `reloads`, `terminations`, `recoveries`, `touchSends`,
  `infoSends`, `keySends`, `controllerSends`, `errors`, `saves`, `downloadBytes`, `downloadMs`,
  `latencyMs`, `battery`.
- Flag stats (true or false): `lowPower`, `lockdown`, `voiceOver`, `headphones`, `charging`,
  `vision`.
- Word stats: `audio` (running, suspended, closed, interrupted), `mode` (menu, fight, pause),
  `core` (mupen64plus_next, parallel_n64), `input` (touch, keyboard, controller), `thermal`
  (nominal, fair, serious, critical), `route` (speaker, receiver, wired, bluetooth, airplay, usb,
  carplay, other).
- Pattern stats: `device` (a model id such as `iPhone16,2`), `os` (such as `26.0.1`), `app` (such
  as `1.2.339`).

A new stat or word is a change to `DIAG_STATS` in `router.ts` and to this list.

There is no streaming route, so nothing here needs Range or `no-transform`. If one is ever added,
set `Cache-Control: no-transform`, because the server's compression gzips wasm on the fly.

## Storage layout (private bucket, `arcade/` prefix)

```
arcade/catalog.json
arcade/kit/<ver>/pack.json
arcade/kit/<ver>/blob.bin
arcade/games/<id>/<ver>/pack.json
arcade/games/<id>/<ver>/blob.bin
```

- The bucket is the Library's (`KADE_MEDIA_BUCKET`, else `AWS_BUCKET_NAME`). Never put arcade
  files under `media-library/` (the unreferenced-file sweep) or `book-imports/` (the storage
  keeper deletes them after 14 days).
- **Never overwrite a key.** A new build of a pack is a new `<ver>`. Old hidden versions outside
  the Library are deleted after 7 days, so an overwrite also loses the old bytes.
- With no `catalog.json` the arcade is simply empty. The server reads the catalog at most once a
  minute; after a failed read it keeps serving the last good catalog and tries again 10 seconds
  later. `pack.json` files are kept for 10 minutes once found, and a missing one is asked for
  again after a minute. Found and missing answers are kept apart (64 of each, oldest out first),
  so requests for made-up versions never push a real index out.

`catalog.json`:

```json
{
  "kit": { "version": "4.2.3-1", "size": 4100000, "sha256": "<64 hex>" },
  "games": [
    {
      "id": "xena",
      "title": "Xena Warrior Princess",
      "console": "N64",
      "access": "family",
      "version": "2026-10-20a",
      "size": 47000000,
      "sha256": "<64 hex, optional>",
      "note": "optional, under 200 characters",
      "grownUpsOnly": true
    }
  ]
}
```

A row needs a unique `id`, a `version` and a `title`, or it is skipped and the log names it. An
`access` that is not exactly `"public"` makes the game a family game, so a typo never opens a game
to everyone. The ids `family-shelf` and `kit` are reserved. `grownUpsOnly` counts only when it is
exactly `true`.

`pack.json` names the blob it indexes and lists every file inside it:

```json
{
  "format": 1,
  "blob": { "size": 47000123, "sha256": "<64 hex>" },
  "files": [{ "path": "games/xena/play.html", "offset": 0, "size": 2048, "mime": "text/html" }],
  "entry": "games/xena/play.html",
  "emulatorData": "emulator/"
}
```

It never reaches the phone as is. The server keeps only `format`, `blob`, `files` and the optional
`entry` (a game pack's page) and `emulatorData` (the kit's EmulatorJS folder); every other field,
such as build notes or a local path, is dropped. Each file row keeps `path`, `offset`, `size` (or
`length`), and `mime` and `sha256` when they are well formed. The pack is not ready (404, never
signed) unless `files` is a non-empty list in which every `path` is a relative path made of letters,
digits, spaces and `._,'()+-` (no leading `/`, no `.` or `..` part, no backslash or colon, no empty
part), no path is listed twice, and every file lies inside the blob. A kit pack that lists any path
under `games/` is refused outright, because the kit is open to every account.

## Adding a game (or a new version of one)

1. Build the pack on Kade's PC with the Revival kit's pack tools (`make_pack.py`, then
   `pack_check.py`). They write `pack.json` and `blob.bin` outside any git working tree.
2. Pick a new version string, for example `2026-10-20a`. Never reuse one.
3. Upload `pack.json` and `blob.bin` to `arcade/games/<id>/<ver>/` (`upload_pack.py`, which never
   prints credentials). Upload the pack before the catalog points at it.
4. Download `arcade/catalog.json`, add or update the game's row (`version`, `size`, `sha256`,
   `access`), and upload it. This one key is meant to change; it is small and the server reads it
   fresh within a minute.
5. Check it: `GET /api/kade/arcade/config` as a family account shows the game. As an account
   outside the pack it shows only "Family shelf". `GET /games/<id>/manifest` answers `ready: true`
   with two packs, and each pack's `signPath` answers a link whose download matches its `sha256`.

A new kit version works the same way under `arcade/kit/<ver>/`, then the catalog's `kit` row.

Uploads, the catalog and deploys need Kade's yes. This router reads storage and never writes it.
