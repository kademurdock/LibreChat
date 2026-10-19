# The Arcade (server side)

Added Oct 18 2026. The Arcade lets the Kade AI app play games on the phone from packs of game
files. This router (`router.ts`) is the server's whole part: it lists the games, says who may play
each one, and gives out one-hour signed download links. Game files never pass through the server,
and none of them belong in this repository, `client/public`, the app bundle or CI.

Wiring: `api/server/routes/kadeArcade.js` (bucket, the Library's `signGet`, the diagnostics rate
limiter, logger), mounted at `/api/kade/arcade` in `api/server/index.js` before the `/api/kade`
catch-all. Tests: `router.test.ts` here and `../family/pack.test.ts`.

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

## Routes

Every route needs sign-in (`requireJwtAuth`, a Bearer header) and answers `Cache-Control: no-store`.

| Route | Answer |
| --- | --- |
| `GET /config` | `{ catalog: [{ id, title, console, access, version, size, locked, note? }], features, familyPack, note, kit: { version, size } \| null }`. `features` is the person's whole pack map, `arcadeFamily` included. |
| `GET /games/:id/manifest` | `{ id, title, console, access, version, size, sha256, kit, ready, index }`. `index` is the current version's `pack.json` (null and `ready: false` before it is uploaded). 403 with the refusal outside the pack for a family game. |
| `GET /games/:id/:ver/pack` | `{ url, sha256, size, version, expiresIn: 3600 }`. `url` is a signed GET for exactly `blob.bin` of that version, good for one hour. `sha256` and `size` come from that version's `pack.json`. 404 until `pack.json` exists. Any uploaded version signs, so a resumed download can finish. |
| `GET /kit/:ver/manifest` | `{ version, size, sha256, ready: true, index }` for every signed-in account. |
| `GET /kit/:ver/pack` | Same shape as a game pack, for every signed-in account (the kit is open-source code). |
| `POST /diag` | Body `{ kind, game?, version?, stats? }`, at most 4 KB, 12 a minute per account. Kept: `kind`, a valid game id and version, and up to 24 `stats` fields whose values are numbers, booleans or short plain words. Everything else, free text included, is dropped. Logged as `[arcade/diag]` with the account id and nothing else about the person. Answers 204. |

`:id` must match `^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$`, and `:ver` must match
`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,30}[A-Za-z0-9])?$` with no `..`. Anything else is a 404 before
any storage key is built.

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
  again after a minute.

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
      "note": "optional, under 200 characters"
    }
  ]
}
```

A row needs a unique `id`, a `version` and a `title`, or it is skipped and the log names it. An
`access` that is not exactly `"public"` makes the game a family game, so a typo never opens a game
to everyone. The id `family-shelf` is reserved.

`pack.json` must name the blob it indexes. The rest is the kit's file table, passed through as is:

```json
{ "format": 1, "blob": { "size": 47000123, "sha256": "<64 hex>" }, "files": [ ... ] }
```

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
   outside the pack it shows only "Family shelf". `GET /games/<id>/<ver>/pack` answers a link whose
   download matches `sha256`.

A new kit version works the same way under `arcade/kit/<ver>/`, then the catalog's `kit` row.

Uploads, the catalog and deploys need Kade's yes. This router reads storage and never writes it.
