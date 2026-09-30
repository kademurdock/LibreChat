/* Family history: the iPhone app's made-up demo family, written from the server itself.
 *
 * Runs every v2 route through the real router on the invented family in __fixtures__/history, as
 * Jack Example (the owner's brother, matched to his place in the tree), and writes the app's
 * FamilyDemoData.swift: one raw-string JSON answer per route, `#if DEBUG` only, pictures as
 * initials (every signed address is left out). The app's CI decodes each answer, so a server
 * shape the app no longer reads fails its gate. THE REPOSITORY IS PUBLIC: the fixture is made up.
 *
 * Run from the repo root:
 *   node --require <tsx>/dist/cjs/index.cjs packages/api/src/family/dump-native-fixtures.ts \
 *     <path to the app's Sources/FamilyDemoData.swift>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { FamilyHistoryAccount } from './history';
import { familyHistoryRouter } from './history';

const FIXTURES = join(__dirname, '__fixtures__', 'history');
const SIGNED = 'https://demo.invalid/';
const JACK: FamilyHistoryAccount = {
  id: 'aaaaaaaaaaaaaaaaaaaaaa21',
  name: 'Jack Example',
  kadeFamilyTreePerson: '@I101@',
};
const STORY =
  '# The farm on Example Road\n\nWe lived on an invented farm on Example Road [records/ancestry/c1/r1.json]. ' +
  'Grandpa Dan kept bees there. Every summer the whole family came back for the honey.\n\n' +
  '## Later\n\nThen the family moved to an invented town. The farm was sold, but the bees stayed.\n';

/** Every answer the app's demo mode serves, by the Swift name it has always used. */
const ROUTES: readonly [string, string, object?][] = [
  ['me', '/me'],
  ['home', '/home?since=v0'],
  ['tree', '/tree?v=2&up=3&down=1'],
  ['personDan', `/person/${encodeURIComponent('@I300@')}?v=2`],
  ['personHugo', `/person/${encodeURIComponent('@I400@')}?v=2`],
  ['gallery', '/gallery'],
  ['mediaInfo', '/media/m-tree1/info'],
  ['signed', '/media/sign', { ids: ['m-tree1', 'm-tree1r', 'm-grave1', 'm-rec1'], size: 't' }],
  ['dna', '/dna'],
  ['timeline', '/timeline'],
  ['places', '/places'],
  ['stories', '/stories?v=2'],
  ['story', '/story/the-farm?v=2'],
  ['findings', '/findings?v=2'],
  ['mysteries', '/findings?group=mysteries'],
  ['play', '/play?seed=7&count=5'],
  ['people', '/people?v=2&group=ancestor'],
  ['search', '/search?v=2&q=example'],
  [
    'noteSent',
    '/note',
    { kind: 'memory', about: { personId: '@I300@' }, text: 'An invented memory.' },
  ],
];

/** Signed addresses become null (the demo draws initials) and a signing map becomes empty. */
function withoutLinks(value: unknown): unknown {
  if (typeof value === 'string') return value.startsWith(SIGNED) ? null : value;
  if (Array.isArray(value)) return value.map(withoutLinks);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'urls' && item && typeof item === 'object') out[key] = {};
      else out[key] = withoutLinks(item);
    }
    return out;
  }
  return value;
}

/** A Swift raw multi-line string literal holding `json`, with a delimiter it cannot contain. */
function rawString(json: string): string {
  let hashes = '##';
  while (json.includes(`"${hashes}`) || json.includes(`\\${hashes}`)) hashes += '#';
  const body = json
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
  return `${hashes}"""\n${body}\n    """${hashes}`;
}

export async function familyDumpNativeFixtures(): Promise<Record<string, string>> {
  const objects = new Map<string, Buffer>([
    ['family-history/current.json', Buffer.from(JSON.stringify({ version: 'v1' }))],
    ['family-history/v1/bundle.json.gz', readFileSync(join(FIXTURES, 'bundle.json'))],
    ['family-history/v1/stories/the-farm.md', Buffer.from(STORY)],
    ['family-history/media/m-story1.text.eeee0001.txt', Buffer.from('An invented clipping.')],
  ]);
  for (const view of ['I100', 'I200', 'I101'])
    objects.set(
      `family-history/v1/views/${view}.json.gz`,
      readFileSync(join(FIXTURES, 'views', `${view}.json`)),
    );
  const router = familyHistoryRouter({
    auth: (req, _res, next) => {
      (req as { user?: FamilyHistoryAccount }).user = JACK;
      next();
    },
    loadObject: async (key) => objects.get(key) || null,
    signGet: async (key) => `${SIGNED}${key}`,
    findUsers: async () => [JACK],
    setUserFields: async () => null,
    putObject: async (key, body) => {
      objects.set(key, body);
    },
    listKeys: async (prefix) => [...objects.keys()].filter((key) => key.startsWith(prefix)),
    /* 5 March 2026: On this day has something to say */
    now: () => Date.parse('2026-03-05T12:00:00Z'),
  });
  const app = express();
  app.use('/fh', router);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fh`;
  const answers: Record<string, string> = {};
  try {
    for (const [name, path, body] of ROUTES) {
      const res = await fetch(base + path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (res.status !== 200) throw new Error(`${path} answered ${res.status}`);
      const json = withoutLinks(await res.json()) as Record<string, unknown>;
      if (name === 'noteSent') json.id = '20260305T120000Z-00000000';
      answers[name] = JSON.stringify(json, null, 2);
    }
    const dan = JSON.parse(answers.personDan) as { pictures: { items: { showing: string }[] } };
    const restored = dan.pictures.items.find((item) => item.showing === 'restored');
    if (!restored) throw new Error('the demo lost its restored photo');
    answers.photoDanRestored = JSON.stringify(restored, null, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return answers;
}

export function familyDemoSwift(answers: Record<string, string>): string {
  const constants = Object.keys(answers)
    .map((name) => `    static let ${name} = ${rawString(answers[name])}`)
    .join('\n\n');
  return `import Foundation

// MARK: - The made-up demo family (DEBUG builds only)
//
// GENERATED by the website's packages/api/src/family/dump-native-fixtures.ts from its fictional
// fixture family ("Ada Example" and her relatives in Invented County), as Jack Example, the
// owner's brother. Nobody here is real. Do not edit by hand: change the server or the fixture and
// run the script again. Release builds do not contain this file's contents at all (no made-up
// family preview in Release), so App Review and unmatched accounts meet only the greyed row.
//
// Used by the -KadeFamilyDemo launch argument (the tour, the accessibility audit, previews) and
// by run-family-tests.sh, which decodes every answer here. Pictures are initials only (no links).

#if DEBUG
enum FamilyDemoData {
    /// The answer for one API path (after "api/kade/family-history/"), or nil for a 404.
    static func payload(path: String, query: [String: String] = [:]) -> String? {
        if path.hasPrefix("person/") {
            switch String(path.dropFirst("person/".count)) {
            case "@I300@": return personDan
            case "@I400@": return personHugo
            default: return nil
            }
        }
        if path.hasPrefix("story/") {
            return path == "story/the-farm" ? story : nil
        }
        if path.hasPrefix("media/") {
            if path == "media/sign" { return signed }
            if path == "media/m-tree1/info" { return mediaInfo }
            return nil
        }
        switch path {
        case "me": return me
        case "home": return home
        case "tree": return tree
        case "gallery": return gallery
        case "dna": return dna
        case "timeline": return timeline
        case "places": return places
        case "stories": return stories
        case "findings": return query["group"] == "mysteries" ? mysteries : findings
        case "play": return play
        case "people": return people
        case "search": return search
        case "note": return noteSent
        default: return nil
        }
    }

${constants}
}
#endif
`;
}

if (require.main === module) {
  const out = process.argv[2];
  if (!out) {
    console.error("Give the path of the app's Sources/FamilyDemoData.swift.");
    process.exit(2);
  }
  familyDumpNativeFixtures()
    .then((answers) => {
      writeFileSync(out, familyDemoSwift(answers).replace(/\r\n/g, '\n'));
      console.log(`wrote ${Object.keys(answers).length} demo answers to ${out}`);
    })
    .catch((error: Error) => {
      console.error(error.message);
      process.exit(1);
    });
}
