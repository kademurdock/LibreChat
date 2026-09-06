import { randomUUID } from 'node:crypto';

type Theme = 'cookout' | 'records' | 'stories';
interface Guest {
  userId: string;
  name: string;
}
interface Entry {
  name: string;
  userId: string;
  text: string;
  at: string;
}
interface Gathering {
  id: string;
  theme: Theme;
  host: Guest;
  guests: Guest[];
  entries: Entry[];
  round: number;
  startedAt: string;
}
interface Album {
  title: string;
  endedAt: string;
  entries: Entry[];
}
export interface HangoutRoom {
  roomId: string;
  revision: number;
  gathering: Gathering | null;
  album: Album[];
  canHost: boolean;
  canManage: boolean;
}
interface Store {
  read(): Promise<HangoutRoom>;
  save(before: HangoutRoom, after: HangoutRoom): Promise<boolean>;
}
interface Choice {
  label: string;
  cmd: string;
}
export interface HangoutView {
  id: string;
  title: string;
  summary: string;
  prompt: string;
  guests: string[];
  entries: { name: string; text: string }[];
  choices: Choice[];
}
interface Reply {
  ok: boolean;
  lines: string[];
  sounds: string[];
  choices: Choice[];
  wantRoom: boolean;
  event?: string;
}
const themes: Record<
  Theme,
  {
    title: string;
    opening: string;
    prompts: string[];
    contributions: { key: string; label: string; line: string; sound: string }[];
  }
> = {
  cookout: {
    title: 'Cookout',
    opening: 'sets up a cookout. Plates and food are on the table. Help yourself.',
    prompts: [
      'The cookout has one house rule. Make it a good one.',
      'Somebody brought a mystery dish. What is it?',
      'The neighbor has come over to complain. About what?',
      'One guest has a terrible business idea. Pitch it.',
      'What song gets everybody out of their chairs?',
      'Who is leaving with all the leftovers?',
    ],
    contributions: [
      {
        key: 'grill',
        label: 'Take a turn at the grill',
        line: 'turns the food on the grill and puts a fresh plate on the table.',
        sound: '',
      },
      {
        key: 'plates',
        label: 'Set out plates',
        line: 'sets out a stack of plates and makes room for another chair.',
        sound: '',
      },
      {
        key: 'snacks',
        label: 'Put out snacks',
        line: 'opens the chips. There is dip on the table, if anyone remembered a spoon.',
        sound: 'hangout.snacks',
      },
    ],
  },
  records: {
    title: 'Record night',
    opening: 'puts a record on. There is room on the couch.',
    prompts: [
      'Name a song you would defend even if the whole room booed.',
      'The record sleeve has a message written inside. What does it say?',
      'Tell us about a song that takes you back somewhere.',
      'Invent the worst possible name for our band.',
      'The neighbors want to join in. What are they bringing?',
      'What goes on the last record of the night?',
    ],
    contributions: [
      {
        key: 'record',
        label: 'Put the next record on',
        line: 'lifts the needle and puts the next record on.',
        sound: 'hangout.record',
      },
      {
        key: 'snacks',
        label: 'Pass the snacks',
        line: 'passes the bowl of snacks around the room.',
        sound: 'hangout.snacks',
      },
      {
        key: 'seat',
        label: 'Pull up another chair',
        line: 'pulls up another chair beside the couch.',
        sound: 'hangout.seat',
      },
    ],
  },
  stories: {
    title: 'Story circle',
    opening: 'pulls up a few chairs. We are making up a story together, a line at a time.',
    prompts: [
      'There is a wedding cake in the back of a stolen shopping cart. Start there.',
      'Your new roommate has one rule. Nobody is allowed to open the freezer.',
      'Someone at this table just won a lifetime supply of something useless.',
      'The dog comes home with a key that does not belong to any of us.',
      'We bought a diner. The first customer is already asking for a refund.',
      'The last bus stops outside a house that was not there yesterday.',
    ],
    contributions: [
      {
        key: 'seat',
        label: 'Pull up another chair',
        line: 'pulls up another chair.',
        sound: 'hangout.seat',
      },
      {
        key: 'snacks',
        label: 'Pass the snacks',
        line: 'passes the snacks while the story goes around.',
        sound: 'hangout.snacks',
      },
    ],
  },
};
const themeKeys = Object.keys(themes) as Theme[];
const time = () => new Date().toISOString();
const clean = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function hangoutView(room: HangoutRoom, userId: string): HangoutView | null {
  const g = room.gathering;
  if (!g) return null;
  const theme = themes[g.theme];
  const joined = g.guests.some((guest) => guest.userId === userId);
  const cmd = (action: string) => `hangout ${action} @${g.id}`;
  const choices = joined
    ? [
        ...theme.contributions.map((c) => ({ label: c.label, cmd: cmd(c.key) })),
        { label: 'Another topic', cmd: cmd('topic') },
        { label: 'Leave the hangout', cmd: cmd('leave') },
      ]
    : [{ label: 'Join in', cmd: cmd('join') }];
  if (g.host.userId === userId || room.canManage)
    choices.push({ label: 'Finish and keep the memories', cmd: cmd('finish') });
  return {
    id: g.id,
    title: theme.title,
    summary: `${g.host.name} is hosting. ${g.guests.length} ${g.guests.length === 1 ? 'person has' : 'people have'} joined. Come and go whenever you like.`,
    prompt: theme.prompts[g.round % theme.prompts.length],
    guests: g.guests.map((guest) => guest.name),
    entries: g.entries.slice(-12).map(({ name, text }) => ({ name, text })),
    choices,
  };
}

function reply(
  room: HangoutRoom,
  actor: Guest,
  lines: string[] = [],
  sound = '',
  event = '',
): Reply {
  const view = hangoutView(room, actor.userId);
  return {
    ok: true,
    lines,
    sounds: sound ? [sound] : [],
    choices: view?.choices ?? [],
    wantRoom: true,
    ...(event ? { event } : {}),
  };
}
function fail(line: string): Reply {
  return { ok: false, lines: [line], sounds: [], choices: [], wantRoom: true };
}

export async function runHangout(store: Store, actor: Guest, raw: string): Promise<Reply> {
  const input = clean(raw);
  const token = input.match(/ @([a-f0-9-]{36})$/);
  const arg = token ? input.slice(0, token.index) : input;
  const action = arg.toLowerCase();
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = await store.read();
    const g = before.gathering;
    if (token && (!g || g.id !== token[1]))
      return fail('That hangout has finished. Open Hangout to see what is happening here now.');
    if (action === 'memories') {
      return reply(
        before,
        actor,
        before.album.length
          ? before.album.flatMap((a) => [
              a.title + '.',
              ...a.entries.map((e) => `${e.name}: ${e.text}`),
            ])
          : ['No hangout memories here yet. Finish a hangout to keep its shared moments.'],
      );
    }
    if (!action) {
      if (g) {
        const view = hangoutView(before, actor.userId)!;
        return reply(before, actor, [
          view.title + '. ' + view.summary,
          view.prompt,
          'Add a line with “hangout add” followed by your words. You can also just listen.',
          ...view.entries.map((e) => `${e.name}: ${e.text}`),
        ]);
      }
      return {
        ...reply(before, actor, [
          'Start something here. Food and supplies are provided. There is no cover charge. Everyone can join, contribute, or just listen.',
        ]),
        choices: [
          ...(before.canHost
            ? themeKeys.map((key) => ({ label: themes[key].title, cmd: `hangout host ${key}` }))
            : []),
          { label: 'Read shared memories', cmd: 'hangout memories' },
        ],
      };
    }
    let next: Gathering | null = g
      ? { ...g, guests: [...g.guests], entries: [...g.entries] }
      : null;
    let album = before.album;
    let line = '',
      sound = '';
    if (action.startsWith('host ')) {
      const theme = action.slice(5) as Theme;
      if (!themeKeys.includes(theme)) return fail('Choose cookout, records, or stories.');
      if (!before.canHost)
        return fail(
          'Only someone who lives here can host in this home. You can host in a public place.',
        );
      if (g)
        return fail('There is already a hangout here. Join it, or let the host finish it first.');
      next = {
        id: randomUUID(),
        theme,
        host: actor,
        guests: [actor],
        entries: [],
        round: 0,
        startedAt: time(),
      };
      line = `${actor.name} ${themes[theme].opening}`;
      sound = theme === 'records' ? 'hangout.record' : 'hangout.seat';
    } else {
      if (!g || !next) return fail('There is no hangout here yet. Open Hangout to start one.');
      const joined = g.guests.some((guest) => guest.userId === actor.userId);
      if (action === 'join') {
        if (joined) return reply(before, actor, ['You have already joined.']);
        if (g.guests.length >= 64)
          return fail('This hangout is full. You can still chat here, or start another nearby.');
        next.guests.push(actor);
        line = `${actor.name} joins the ${themes[g.theme].title.toLowerCase()}.`;
        sound = 'hangout.seat';
      } else if (action === 'finish') {
        if (actor.userId !== g.host.userId && !before.canManage)
          return fail('The host or someone who lives here can finish this hangout.');
        album = [
          {
            title: `${themes[g.theme].title} with ${g.host.name}`,
            endedAt: time(),
            entries: g.entries.slice(-12),
          },
          ...album,
        ].slice(0, 5);
        next = null;
        line = `${actor.name} wraps up the ${themes[g.theme].title.toLowerCase()}. Its shared moments are saved in this room’s memories.`;
        sound = 'hangout.seat';
      } else {
        if (!joined) return fail('Join the hangout first. You can come and go freely.');
        if (action === 'leave') {
          next.guests = g.guests.filter((guest) => guest.userId !== actor.userId);
          line = `${actor.name} steps out of the hangout.`;
          if (g.host.userId === actor.userId && next.guests.length) {
            next.host = next.guests[0];
            line += ` ${next.host.name} is hosting now.`;
          } else if (!next.guests.length) {
            album = [
              {
                title: `${themes[g.theme].title} with ${g.host.name}`,
                endedAt: time(),
                entries: g.entries.slice(-12),
              },
              ...album,
            ].slice(0, 5);
            next = null;
            line += ' The last guest has left. The shared memories are saved here.';
          }
        } else if (action === 'topic') {
          next.round++;
          line = `${actor.name} starts a new topic: ${themes[g.theme].prompts[next.round % themes[g.theme].prompts.length]}`;
          sound = 'hangout.page';
        } else if (action.startsWith('add ')) {
          const text = clean(arg.slice(4));
          if (!text || text.length > 400)
            return fail(
              'Keep each shared line between 1 and 400 characters. A sentence or two is plenty.',
            );
          const last = g.entries[g.entries.length - 1];
          if (last?.userId === actor.userId && last.text === text)
            return reply(before, actor, ['That line is already in the shared memories.']);
          next.entries = [...g.entries, { ...actor, text, at: time() }].slice(-48);
          line = `${actor.name}: ${text}`;
          sound = 'hangout.page';
        } else {
          const contribution = themes[g.theme].contributions.find((c) => c.key === action);
          if (!contribution)
            return fail(
              'Open Hangout for the choices here, or use “hangout add” followed by your words.',
            );
          line = `${actor.name} ${contribution.line}`;
          sound = contribution.sound;
          next.entries = [...g.entries, { ...actor, text: contribution.line, at: time() }].slice(
            -48,
          );
        }
      }
    }
    const after = { ...before, revision: before.revision + 1, gathering: next, album };
    if (await store.save(before, after)) return reply(after, actor, [line], sound, line);
  }
  return fail('A few people acted together. Open Hangout to catch up, then try your choice again.');
}
