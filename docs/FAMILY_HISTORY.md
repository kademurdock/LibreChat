# Family History (private genealogy section)

The owner's family research, served to the family members whose accounts are matched to a person in the family tree. THIS REPOSITORY IS PUBLIC: no real names, tree ids, findings or family data may ever be committed (code, docs, tests, fixtures). All family data lives only in the private bucket. Page `/family-history`; API `/api/kade/family-history`. Started 29 Sep 2026.

## The owner's decisions (29 Sep 2026)
- **Who gets in:** only accounts matched to a person in the tree ("blood and married-in family"), plus admins (the owner). Close friends in the Family feature pack do NOT get in unless the owner adds them one by one (guest access, which sees the tree from the owner's place).
- **Sensitive research findings** are visible to every matched family member, clearly marked as research findings, not proven.
- **Children** see the same as adults.
- Living people who are not on the platform appear by name and relationship only: no record transcriptions and no exact dates (public-records indexes carry addresses). The export already strips those.
- The App Review seat and test seats never get in, and a refused account is told plainly it is private to the family (no greyed-out control is needed: this is a page, not a Family pack feature).

## Data (built offline from the owner's archive, uploaded to B2)
Bucket `KADE_MEDIA_BUCKET || AWS_BUCKET_NAME`, prefix `KADE_FAMILY_HISTORY_PREFIX || 'family-history'`.
- `<prefix>/current.json` = `{"version": "20260929-151200"}` (the only object that is ever overwritten).
- `<prefix>/<version>/bundle.json.gz`: gzip JSON, ~3 MB unzipped:
  - `version`, `generated`, `owner` (the owner's tree id), `counts`, `anchors` (tree ids that have a view file)
  - `people[id]`: `id, name, label, sex, birthSurname, lifespan, living, virtual, confidence, birth{date,place}, death{date,place}, burial{date,place}, otherNames[], facts[{type,label,date,year,place,value,note,records[key]}], parents[{id,kind: birth|step|probable|doubtful|adopted}], spouses[id], children[id], records[key], wrongRecords{key: why}, memorials[mid], wrongMemorials{mid: why}, media[mediaId], notes[], history[], duplicateOf, duplicateWhy, conflict, ownerRelation, ownerGroup`
  - `records[key]` (key = "collectionId:recordId"): `key, collection, name, fields[[label,value]], tables[[[cells]]], citation, url, image (mediaId|null)`
  - `memorials[mid]`: `id, name, birth_date, birth_place, death_date, death_place, cemetery, cemetery_place, plot, inscription, bio, url, family{heading:[{memorial_id,name,dates}]}, photos[{media, caption}], family_notes[]`
  - `media[mediaId]`: `id, kind (record|grave|tree|codex), file ("media/<id>.<ext>", relative to the version folder's parent: key = <prefix>/media/<id>.<ext>), caption, people[], bytes, date?, place?, description?`
  - `findings[{summary, people[]}]`, `stories[{slug,title,file,words}]` (file relative to the version folder, markdown), `sources{sid:{title}}`, `codexSources[...]`
- `<prefix>/<version>/views/<id without @>.json.gz`: `{anchor, relations: {personId: {term, group: self|ancestor|descendant|blood|marriage, gen?, distance?, path?[ids from the anchor up to the shared ancestor(s) and down], pathText?, notes?[]}}}`. A person missing from `relations` has no known link to the anchor.
- `<prefix>/media/<mediaId>.<ext>`: images (jpg/png/pdf...). Media files are NOT versioned (same id = same file).

## Access rule (server-enforced)
`familyHistoryViewer(user, bundle)` returns `{personId, mode}` or null:
1. review seat (reuse `libraryReviewSeat` from `packages/api/src/library/access.ts`) → null
2. test seats (`libraryTestSeat`) → null, even when ADMIN, matched or a guest (the owner's rule: test seats never get in)
3. `user.kadeFamilyTreePerson` set and present in `bundle.people` → that person (mode `family`). If it is a duplicate entry, use `duplicateOf`.
4. `user.role === 'ADMIN'` → the bundle owner (mode `owner`)
5. `user.kadeFamilyHistory === 'guest'` → the bundle owner (mode `guest`)
6. otherwise null.
If the viewer's person has no view file, use the owner's view and say so (`viewNote`).
New User schema fields (packages/data-schemas/src/schema/user.ts, beside kadeLibraryAccess): `kadeFamilyTreePerson: String` (a tree id like "@I123@"), `kadeFamilyHistory: {type: String, enum: ['guest','none']}`. Types in packages/data-schemas/src/types/user.ts.

## API (all `requireJwtAuth`, JSON, `Cache-Control: no-store`)
- `GET /me` → `{access: true, viewer: {personId, name, label, relationToOwner}, mode, isOwner, version, counts, viewNote?}` or `403 {access:false, error: "The family history is private to the family."}`
- `GET /person/:id` → `{person (from bundle, plus relation: views[viewer][id] or null), family: {parents[], spouses[], children[], siblings[]} each {id,label,lifespan,relation?,kind?}, records: [record + wrong?], memorials: [memorial with photo media {id, caption}], media: [{id, kind, caption, ...}], findings: [findings that name this person]}`. 404 for unknown ids. Redirect-free: a duplicate returns its own record with `duplicateOf` set (the client offers the real person).
- `GET /tree?focus=<id>&up=4&down=2` (defaults: focus = viewer, up 4, down 2; caps up ≤ 8, down ≤ 4) → `{focus, nodes: [{id,label,lifespan,sex,relation?,living,virtual,photo?(mediaId)}], links: [{parent, child, kind}], couples: [[a,b]]}` covering ancestors up `up` generations, descendants down `down`, and the focus person's siblings and spouses.
- `GET /search?q=<text>` → up to 50 `{id,label,lifespan,relation?}`; match on name, other names and birth surname, case- and punctuation-insensitive; relatives first (by relation distance), then the rest.
- `GET /people?group=ancestor|blood|marriage|all` → compact list `{id,label,lifespan,relation,group,gen?,distance?}` sorted nearest first (ancestors by generation).
- `GET /stories` → `[{slug,title,words}]`; `GET /story/:slug` → `{slug,title,markdown}`.
- `GET /findings` → `[{summary, people:[{id,label,relation?}]}]`.
- `GET /media/:id` → `{url}` a signed GET URL (reuse the Library's `signGet`, 1 hour), only when the media id appears in the bundle; 404 otherwise. `?redirect=1` → 302 to the signed URL (for <img src>).
- Owner only (admin): `GET /accounts` → `[{userId, name, username, personId, personLabel, access, testSeat, changeable}]` for all non-review accounts (`changeable: false` for admins and test seats, whose access can't be changed here); `POST /match {userId, personId|null, guest?: boolean}` sets `kadeFamilyTreePerson` (validated against the bundle) or `kadeFamilyHistory: 'guest'|'none'`; 409 with a reason for the review seat, test seats and admins.
- The bundle and view files are cached in memory for 10 minutes (and after a `current.json` change); a failed load answers 503 `{error: "The family history is being updated. Try again in a minute."}`.

## The page (/family-history)
Server-rendered shell in the kade-pages style (SHARED_HEAD from kadePages.js, green buttons, 880px width, dark mode, focus ring, reduced motion), script `/assets/family/history.js?v=...` and styles `/assets/family/history.css`. Auth like the Library page: `getToken()` via `/api/auth/refresh`, redirect to `/login?redirect_to=/family-history` when signed out.
Sections (one page, hash routes so Back works: `#/`, `#/tree/<id>`, `#/person/<id>`, `#/people`, `#/stories`, `#/story/<slug>`, `#/findings`):
1. **Home:** "Our family history", a card for the viewer ("You're in the tree as <name>"), counts, big buttons: Family tree, People, Stories, Research findings; a short "How to use this" line.
2. **Family tree:** an SVG chart centred on the focus person: ancestors fanning out upward/left by generation, siblings and spouses beside, children below. Each box shows photo (if any), name, years and the relationship to the VIEWER ("your 2nd great-grandmother"), colour-coded by side (father's side / mother's side / by marriage / research finding, with a legend that also uses patterns or labels, never colour alone). Boxes are buttons/links (keyboard and screen reader): activate to open the person, and a "Centre the tree here" action. Pan/zoom buttons (no drag-only controls). Beside the chart, an equivalent **text version** ("Your ancestors, generation by generation") for screen readers.
3. **Person:** photo gallery (tree photos, grave photos, record scans with alt text from captions), name, other names, "born a <surname>", lifespan, **how the viewer is related** (term + the path as a chain of names, as a small horizontal diagram and as text), notes/cautions/history, a **timeline** of facts (date, what, where; each with its source records), family members (links, with relation to viewer), **records**: each as a card with collection, citation, the transcription as a two-column list and household table, the scan (thumbnail → full view) when present, a "wrongly attached" warning when `wrong`, and a link to Ancestry; **Find a Grave**: cemetery, dates, inscription, bio, photos; findings that mention this person.
4. **People:** search box + grouped lists (ancestors by generation, blood relatives nearest first, by marriage).
5. **Stories:** list and a reader (render the markdown safely: headings, paragraphs, lists, emphasis, links; bracketed source paths `[records/ancestry/...json]` become small "source" chips; no raw HTML).
6. **Research findings:** each finding as a card with the people it names.
Accessibility (the owner is blind and uses a screen reader; most of the family are sighted and busy): one h1, real headings per section, `role="status" aria-live="polite"` for loading/errors, focus moves to the new view's heading on navigation, every image has alt text, every chart has a text equivalent, no auto-play, respects prefers-reduced-motion and prefers-contrast. Mobile first (most family use phones): the chart scrolls and zooms inside its frame; the page itself never scrolls sideways.

## Code layout
- `packages/api/src/family/history.ts`: pure helpers (viewer rule, tree slice, search, people lists, markdown-safe story payload) + `familyHistoryRouter(deps)` with injected `auth`, `loadObject(key) -> Buffer|null`, `signGet(key, mime, seconds)`, `findUsers()`, `setUserFields(id, fields)`, `now()`. Export from `packages/api/src/index.ts`.
- `packages/api/src/family/history.test.ts`: node:test, express + fetch, a small fixture bundle in `packages/api/src/family/__fixtures__/`.
- `api/server/routes/kadeFamilyHistory.js`: thin wrapper wiring the real S3 client / Library `signGet` / User model.
- `api/server/routes/kadeFamilyHistoryPage.js` + `client/public/assets/family/history.{js,css}`: the page.
- Mount in `api/server/index.js`: `app.use('/api/kade/family-history', routes.kadeFamilyHistory)` before `app.use('/api/kade', routes.kade)`, and `app.get('/family-history', ...page)`.
- Add a Home tile ("Family history") in `kadeHome.js` shown only when `/api/kade/family-history/me` says access (hidden for everyone else).
- `/family-history` must stay off the service worker's recoverable SPA list (`client/sw/heal.js`).
- Do NOT add npm dependencies. Page scripts in template literals need doubled backslashes; prefer the separate asset file.
