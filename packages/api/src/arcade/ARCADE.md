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
| `GET /games/:id/manifest` | `{ id, title, console, access, version, ready, packs, entry?, emulatorData? }`. `packs` is `[kitPack, gamePack]`, each `{ kind: 'kit' \| 'game', id, version, size, sha256, signPath, files: [{ path, offset, size, mime?, sha256? }] }`: `size` and `sha256` are `blob.bin`'s, `files` is the checked file table from that pack's `pack.json` (the kit's `length` served as `size`, its `type` as `mime`), and `signPath` (for example `/api/kade/arcade/kit/20261018-27899e08/pack`) answers the pack's signed link. The kit pack's id is always `kit`. Until both `pack.json` files are uploaded and pass the checks below, `ready` is false and `packs` is `[]`, so the phone never installs a game without its kit. `entry` (the game page, from the game pack) and `emulatorData` (EmulatorJS's folder, from the kit pack: `emulatorjs/`) appear only when the packs name them; otherwise the app's defaults hold, which must be the kit's own: `games/<id>/play.html` and `emulatorjs/`. 403 with the refusal outside the pack for a family game. |
| `GET /games/:id/:ver/pack` | `{ url, sha256, size, version, expiresIn: 3600 }`. `url` is a signed GET for exactly `blob.bin` of that version, good for one hour. `sha256` and `size` come from that version's `pack.json`. 404 until `pack.json` exists and passes the checks. Any uploaded version signs, so a resumed download can finish. |
| `GET /kit/:ver/manifest` | `{ kind: 'kit', id: 'kit', version, size, sha256, signPath, files, ready: true, emulatorData? }` (the same pack shape as in a game manifest) for every signed-in account. |
| `GET /kit/:ver/pack` | Same shape as a game pack, for every signed-in account (the kit is open-source code). |
| `POST /diag` | Body `{ kind, game?, version?, stats? }`, at most 4 KB, 30 a minute per account (a report every five seconds is 12). `kind` must be one of the listed kinds below, or the answer is 400. Kept: `kind`, a valid game id and version, and only the listed `stats`, each checked for its type; a string stat is kept only when it is one of its listed words or matches its fixed pattern. Any other stat name, and any other string, is dropped, so no field can carry free text. Logged as `[arcade/diag]` with the account id and nothing else about the person. Answers 204. |

`:id` must match `^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$`, and `:ver` must match
`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,30}[A-Za-z0-9])?$` with no `..`. Anything else is a 404 before
any storage key is built. The kit's tools name versions `YYYYMMDD-<first 8 hex of blob.bin's
sha256>`, for example `20261018-27899e08`.

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

The keys the Revival kit's `tools/upload_pack.py` writes (versioned, never overwritten):

```
arcade/catalog.json                          the one key that changes (written by hand today)
arcade/public/kit/<ver>/blob.bin             the kit, uploaded first
arcade/public/kit/<ver>/pack.json            uploaded last
arcade/family/<id>/<ver>/blob.bin            a family game (pack.json "shelf": "family")
arcade/family/<id>/<ver>/pack.json
arcade/public/<id>/<ver>/blob.bin            an openly licensed game ("shelf": "public")
arcade/public/<id>/<ver>/pack.json
```

- A game's folder is its catalog row's `access`: `"public"` reads `public/`, anything else reads
  `family/`. It must equal the pack's `shelf`, which is where `upload_pack.py` put it; a game
  whose row and pack disagree is never found (`ready: false`). The kit is always `public/kit/`
  (`kit` is a reserved game id, so no game can land there).
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

`catalog.json` (written by hand from the two `pack.json` files; no tool writes it yet):

```json
{
  "kit": {
    "version": "20261018-27899e08",
    "size": 2382551,
    "sha256": "27899e08c0bbaffb456747c50fcd9636fbb63d68a54b53d7676741c89d101b6e"
  },
  "games": [
    {
      "id": "xena",
      "title": "Xena Warrior Princess",
      "console": "N64",
      "access": "family",
      "version": "20261018-63fdca17",
      "size": 46518427,
      "sha256": "<blob.sha256 of that pack, optional>",
      "note": "optional, under 200 characters",
      "grownUpsOnly": true
    }
  ]
}
```

Each value comes from that pack's `pack.json`: `version` is its `version`, `size` is
`blob.bytes`, `sha256` is `blob.sha256`, and a game's `access` is its `shelf`. A row needs a
unique `id`, a `version` and a `title`, or it is skipped and the log names it. An `access` that is
not exactly `"public"` makes the game a family game, so a typo never opens a game to everyone. The
ids `family-shelf` and `kit` are reserved. `grownUpsOnly` counts only when it is exactly `true`.

### pack.json, as the kit writes it

`tools/packlib.py write_pack` writes it with `json.dump(indent=1)` in Python text mode, so it has
Windows line endings; its own bytes are never hashed, so that does not matter. A kit pack:

```json
{
 "format": "kadearcade-pack/1",
 "version": "20261018-27899e08",
 "created": "2026-10-18T22:20:29-0500",
 "kind": "kit",
 "id": "kit",
 "name": "Revival kit",
 "shelf": "public",
 "publicBuilds": true,
 "emulatorjs": "4.2.3",
 "emulatorjsSource": "https://cdn.emulatorjs.org/4.2.3/data/",
 "emulatorjsPins": { "loader.js": "<64 hex>", "...": "..." },
 "emulatorData": "emulatorjs/",
 "core": "core/",
 "files": [
  {"path": "core/app.js", "offset": 0, "length": 16160, "sha256": "<64 hex>", "type": "text/javascript; charset=utf-8"},
  {"path": "emulatorjs/cores/mupen64plus_next-wasm.data", "offset": 461211, "length": 1451795, "sha256": "<64 hex>", "type": "application/octet-stream"}
 ],
 "blob": {"file": "blob.bin", "bytes": 2382551, "sha256": "27899e08c0bbaffb456747c50fcd9636fbb63d68a54b53d7676741c89d101b6e"}
}
```

A game pack has `"kind": "game"`, `"id": "xena"`, `"name"`, `"console": "n64"`,
`"shelf": "family"`, `"publicBuilds": false`, `"entry": "games/xena/play.html"`,
`"needsKit": true`, `"voices": [...]`, and no `emulatorData`.

| Field | Meaning | The server |
| --- | --- | --- |
| `files` | a list of rows, sorted by path, contiguous from offset 0 | checks every row, passes the table on |
| `files[].path` | relative, in the kit layout: `core/...` and `emulatorjs/...` (kit), `games/<id>/...` (game). Cloned-voice clip names are the spoken line: 163 characters in one part and 192 in all in the Xena pack | checks it (below) |
| `files[].offset`, `files[].length` | the file's byte slice of `blob.bin`. The name is `length` | serves it as `size` (reads `size` too) |
| `files[].sha256` | sha256 of that slice | passes it on (the app does not check it) |
| `files[].type` | the MIME type, with `; charset=utf-8` for text. The name is `type` | serves it as `mime` when well formed (reads `mime` too, which wins) |
| `blob.bytes`, `blob.sha256` | the size and sha256 of the whole `blob.bin`, which is what the phone checks after downloading. The name is `bytes` | the pack's `size` and `sha256` (reads `blob.size` too, which wins) |
| `entry` (game) | the game page, `games/<id>/play.html` | the manifest's `entry` |
| `emulatorData` (kit) | EmulatorJS's folder inside the kit pack, `emulatorjs/` | the manifest's `emulatorData` |
| everything else (`format`, `version`, `kind`, `id`, `name`, `shelf`, `console`, `voices`, `needsKit`, `created`, `publicBuilds`, `emulatorjs*`, `core`) | build facts | dropped: the catalog is the source for id, title, version and access |

`pack.json` never reaches the phone as is: only the blob's size and sha256, the checked file
table and `entry` / `emulatorData` leave the server, so build notes or a local path in it go
nowhere. The pack is not ready (404, never signed) unless `blob` has a positive whole size and a
sha256, `files` is a non-empty list in which every `path` is a relative path made of letters,
digits, spaces and `._,'()+-` (no leading `/`, no `.` or `..` part, no backslash or colon, no
empty part, no part longer than 255 characters, no path longer than 1,024, a B2 key's limit), no
path is listed twice, and every file lies inside the blob. A kit pack that lists any path under
`games/` is refused outright, because the kit is open to every account.

The default EmulatorJS folder is `emulatorjs/` (EmulatorJS 4.2.3's pinned files: `loader.js`,
`emulator.min.js`, `emulator.min.css`, `localization/en-US.json`,
`cores/reports/mupen64plus_next.json`, `cores/mupen64plus_next-wasm.data`,
`compression/extract7z.js`).

## Adding a game (or a new version of one)

1. Build the pack on Kade's PC with the Revival kit's pack tools (`make_pack.py`, then
   `pack_check.py`). They write `pack.json` and `blob.bin` outside any git working tree, under a
   new version `YYYYMMDD-<first 8 hex of blob.bin's sha256>` (for example `20261018-63fdca17`).
   Never reuse one.
2. Upload them with `upload_pack.py` (which never prints credentials and refuses a version that
   already exists): a family game goes to `arcade/family/<id>/<ver>/`, an openly licensed one to
   `arcade/public/<id>/<ver>/`, by the pack's `shelf`. Upload the pack before the catalog points
   at it.
3. Download `arcade/catalog.json`, add or update the game's row from its `pack.json`
   (`version` = `version`, `size` = `blob.bytes`, `sha256` = `blob.sha256`, `access` = `shelf`),
   and upload it. This one key is meant to change; it is small and the server reads it fresh
   within a minute.
4. Check it: `GET /api/kade/arcade/config` as a family account shows the game. As an account
   outside the pack it shows only "Family shelf". `GET /games/<id>/manifest` answers `ready: true`
   with two packs, `entry` and `emulatorData: "emulatorjs/"`, and each pack's `signPath` answers a
   link whose download matches its `sha256`. `ready: false` with the packs uploaded means a key
   or a `pack.json` the server could not use: the log names the key when the file was found but
   refused.

A new kit version works the same way under `arcade/public/kit/<ver>/`, then the catalog's `kit`
row.

Uploads, the catalog and deploys need Kade's yes. This router reads storage and never writes it.
