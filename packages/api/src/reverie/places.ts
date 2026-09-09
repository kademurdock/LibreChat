export const GULLY_LAUNDRY = {
  roomId: 'gully_laundry',
  name: 'the Gully Washhouse',
  district: 'patch',
  desc: 'Washers turn behind round glass doors. Warm air carries laundry soap and clean cotton. A wide folding table runs down the middle, with a bench beside the front window. Nell keeps spare buttons in a blue tin. Gully Road is southwest through the screen door.',
  exits: { sw: 'patch_gully_road' },
  props: {
    outdoor: false,
    surface: 'linoleum',
    smell: 'Laundry soap, clean cotton, and warm air from the dryers.',
    listenLine: 'A steady washer motor turns under the soft tumble of damp cloth.',
    doings:
      'Wash clothes, fold laundry, sort buttons, repair the window bench, or read at the book exchange.',
    sleepable: true,
  },
};

export function laundryAction(command: string): {
  label: string;
  line: string;
  clean: number;
  doing: string;
  event: string;
} {
  if (command === 'sort buttons')
    return {
      label: 'Sort buttons',
      line: 'You sort a handful of buttons by touch: smooth, ridged, two holes, four. You return them to the blue tin, in separate little cups. The tin belonged to Nell’s mother, who taught Nell and her sister to mend.',
      clean: 0,
      doing: 'sorting spare buttons',
      event: 'sorts spare buttons into the little cups in the blue tin.',
    };
  return command === 'fold laundry'
    ? {
        label: 'Fold laundry',
        line: 'You fold the warm laundry into a neat stack on the table.',
        clean: 0,
        doing: 'folding warm laundry',
        event: 'folds a stack of warm laundry.',
      }
    : {
        label: 'Wash clothes',
        line: 'You wash a small load and bring it back warm from the dryer. The folding table has room for it.',
        clean: 18,
        doing: 'washing clothes',
        event: 'finishes a small load at the washers.',
      };
}

export const WASHHOUSE_BOOKS = [
  {
    id: 'platform',
    title: 'The Empty Platform',
    pages: [
      'The station clock stopped at six. On the platform sat a suitcase with a damp handle and dry feet. The porter said nobody had arrived in the rain. The detective put a hand under the bench: dry there, too.',
      'Inside the case were a towel, a railway timetable, and a ticket for yesterday. The towel smelled of soap. The handle had been washed. The detective asked the porter where he kept the lost property.',
      'The case had never left the station. The porter had cleaned it for its owner, who was coming back after a hospital stay. He had hidden the name tag from an overcurious neighbor. The detective shut the case and left a note: no crime, and none of our business.',
    ],
  },
  {
    id: 'key',
    title: 'The Brass Key',
    pages: [
      'Every morning a brass key appeared on the kitchen table. Every evening the householder put it in a drawer. Nothing was missing. No lock in the house accepted it. She dusted the table with flour before bed.',
      'At dawn there were two clean circles in the flour, a small crescent, and the key. She set a cup on one circle. A saucer fitted the other. The crescent fitted the edge of her own sleeve.',
      'She had been laying out breakfast in her sleep, just as she once had for her father. The key was for his old tea caddy. She put the caddy on the table and called her sister. They had breakfast together on Sunday.',
    ],
  },
  {
    id: 'page',
    title: 'The Missing Page',
    pages: [
      'The last page was missing from every copy of the same mystery in the little bookshop. The cuts were straight. The bookseller blamed a customer who hated endings. His assistant asked why the wastebasket held only thin white strips.',
      'The assistant held one strip against a damaged book. It matched the margin. Then she looked at the paper cutter, the stack of newly wrapped parcels, and the bookseller, who had gone very quiet.',
      'He had been trimming damaged covers and cutting through the final page by mistake. The publisher sent replacements. Until they arrived, the assistant wrote the ending on slips kept behind the counter. Customers could ask for one, or argue about their own.',
    ],
  },
] as const;

const BENCH_STEPS = [
  {
    label: 'Tighten the loose leg',
    line: 'You tighten the loose leg with the screwdriver from the repair tray.',
    event: 'tightens the loose leg of the window bench.',
  },
  {
    label: 'Sand the rough edge',
    line: 'You sand the rough edge until it is smooth under your fingers.',
    event: 'sands the rough edge of the window bench.',
  },
  {
    label: 'Fit the felt pads',
    line: 'You fit felt pads beneath the feet. The window bench stands steady, ready for the next person.',
    event: 'finishes the window bench and sets it steady on its felt pads.',
  },
] as const;

interface BenchView {
  stage: number;
  line: string;
  choices: { label: string; cmd: string }[];
  action?: { label: string; line: string; event: string };
}

export function washhouseBench(step: number = 0): BenchView {
  const stage = Number.isFinite(step)
    ? Math.max(0, Math.min(BENCH_STEPS.length, Math.floor(step)))
    : 0;
  const action = BENCH_STEPS[stage];
  return {
    stage,
    line:
      stage === 3
        ? 'The window bench is repaired: its leg is tight, its edge smooth, and felt pads keep it steady.'
        : `The window bench needs a little work. ${stage} of 3 repairs are finished. Next: ${action.label.toLowerCase()}. The repair tray supplies what you need.`,
    choices: action ? [{ label: action.label, cmd: `repair bench ${stage}` }] : [],
    action,
  };
}

function washhouseBook(id: string): (typeof WASHHOUSE_BOOKS)[number] | undefined {
  return WASHHOUSE_BOOKS.find((book) => book.id === id);
}

export function washhouseReadingChoices(
  pages: Partial<Record<string, number>>,
): { label: string; cmd: string }[] {
  return WASHHOUSE_BOOKS.flatMap((book) => {
    const page = Math.max(0, Math.min(book.pages.length, pages[book.id] || 0));
    const forward =
      page < book.pages.length
        ? {
            label: `${book.title}: read part ${page + 1} of ${book.pages.length}`,
            cmd: `read washhouse ${book.id} ${page}`,
          }
        : { label: `${book.title}: read again`, cmd: `reread washhouse ${book.id}` };
    return page > 0
      ? [
          forward,
          {
            label: `${book.title}: reopen part ${page}`,
            cmd: `reopen washhouse ${book.id} ${page - 1}`,
          },
        ]
      : [forward];
  });
}

interface WashhouseReply {
  ok: boolean;
  lines: string[];
  choices: { label: string; cmd: string }[];
  sounds: string[];
  wantRoom?: boolean;
  event?: string;
}
interface WashhouseStore {
  bench(): Promise<number>;
  repair(stage: number): Promise<boolean>;
  bookmark(id: string, before: number, after: number): Promise<boolean>;
  page(id: string): Promise<number>;
}

export async function runWashhouse(
  store: WashhouseStore,
  command: string,
  arg: string,
): Promise<WashhouseReply> {
  const reply = (ok: boolean, ...lines: string[]): WashhouseReply => ({
    ok,
    lines,
    choices: [],
    sounds: [],
  });
  if (command === 'repair bench') {
    const bench = washhouseBench(await store.bench());
    if (!arg) return { ...reply(true, bench.line), choices: bench.choices };
    if (!bench.action || arg !== String(bench.stage))
      return {
        ...reply(false, 'That repair has already changed. ' + bench.line),
        choices: bench.choices,
      };
    if (!(await store.repair(bench.stage)))
      return reply(
        false,
        'Someone has just worked on the bench, or you have left the room. Open Window bench to see what is left.',
      );
    const next = washhouseBench(bench.stage + 1);
    return {
      ...reply(true, bench.action.line, next.line),
      choices: next.choices,
      event: bench.action.event,
      wantRoom: true,
    };
  }
  const [id, pageText, ...extra] = arg.split(' ');
  const book = washhouseBook(id);
  const reread = command === 'reread washhouse';
  if (!book || extra.length || (reread ? !!pageText : !/^[0-2]$/.test(pageText || '')))
    return reply(false, 'Open Book exchange and choose a story to read.');
  const page = reread ? book.pages.length : Number(pageText);
  if (command === 'reopen washhouse') {
    const savedPage = await store.page(book.id);
    if (page >= savedPage)
      return reply(
        false,
        'That part has not been opened yet. Choose the next part from Book exchange.',
      );
    const choices = [{ label: 'Back to book exchange', cmd: 'book exchange' }];
    if (page > 0)
      choices.unshift({ label: 'Previous part', cmd: `reopen washhouse ${book.id} ${page - 1}` });
    return {
      ...reply(true, `${book.title}, part ${page + 1} of ${book.pages.length}.`, book.pages[page]),
      choices,
      sounds: ['hangout.page'],
    };
  }
  const next = reread ? 0 : page + 1;
  if (!(await store.bookmark(book.id, page, next)))
    return reply(
      false,
      'Your bookmark has changed, or you have left the room. Open Book exchange to continue from your saved place.',
    );
  const choices =
    next < book.pages.length
      ? [
          {
            label: `Read part ${next + 1} of ${book.pages.length}`,
            cmd: `read washhouse ${book.id} ${next}`,
          },
        ]
      : [{ label: 'Read this story again', cmd: `reread washhouse ${book.id}` }];
  choices.push({ label: 'Back to book exchange', cmd: 'book exchange' });
  const lines = reread
    ? [`You move the bookmark to the beginning of ${book.title}.`]
    : [
        `${book.title}, part ${page + 1} of ${book.pages.length}.`,
        book.pages[page],
        next === book.pages.length
          ? 'The end. You put the book back on the shelf.'
          : 'Your place is saved. Read on whenever you like.',
      ];
  return { ...reply(true, ...lines), choices, sounds: reread ? [] : ['hangout.page'] };
}
