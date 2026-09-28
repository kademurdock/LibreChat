export interface GuideRoom {
  roomId: string;
  name: string;
  district: string;
  exits: Record<string, string>;
  props?: { home?: object; locks?: Record<string, boolean>; outdoor?: boolean };
}

export interface GuideProjectState {
  stage: number;
  variant: string;
  finished?: boolean;
  finish?: number;
}

export interface GuideState {
  destination?: string;
  notes?: Record<string, boolean>;
  projects?: Record<string, GuideProjectState>;
}

interface Choice {
  label: string;
  cmd: string;
}
interface GuideResult {
  ok: boolean;
  lines: string[];
  choices?: Choice[];
  kinds?: string[];
  wantRoom?: boolean;
  guide?: {
    title: string;
    summary: string;
    current: string;
    stops: { id: string; name: string; direction?: string }[];
  };
}

export interface GuideStore {
  rooms(): Promise<GuideRoom[]>;
  state(): Promise<GuideState>;
  destination(id: string): Promise<boolean>;
  project(id: string, before: number, after: GuideProjectState): Promise<boolean>;
  deliver(id: string, title: string, description: string): Promise<void>;
  announce(line: string, sound: string): Promise<void>;
  walk(direction: string): Promise<GuideResult>;
}

export const CANAL_STOPS = [
  {
    id: 'foundry_court',
    name: 'Foundry Court',
    command: 'read the foundry board',
    note: 'The mills used canal water for power; the empty buildings became shared workshops.',
  },
  {
    id: 'repair_hall',
    name: 'the Repair Hall',
    command: 'inspect the tool wall',
    note: 'Raised tool outlines, pre-cut timber, and different bench heights make room for different ways of working.',
  },
  {
    id: 'canal_towpath',
    name: 'the Canal Towpath',
    command: 'read the water marks',
    note: 'Three grooves mark low water, working water, and the old flood line.',
  },
  {
    id: 'lock_garden',
    name: 'the Lock Garden',
    command: 'examine the reed bed',
    note: 'Reed roots slow the water and catch sediment before it runs downstream.',
  },
  {
    id: 'glass_canopy',
    name: 'the Glass Canopy',
    command: 'compare the herbs',
    note: 'Mint has a square stem; rosemary has firm narrow leaves; lemon balm smells of citrus.',
  },
  {
    id: 'canal_overlook',
    name: 'the Canal Overlook',
    command: 'trace the canal model',
    note: 'The river, lock, mills, and gardens form one connected water system.',
  },
] as const;

export const GUIDE_WARDS: Record<string, { name: string; description: string }> = {
  gate: { name: 'the Threshold', description: 'Arrive, find your bearings, and enter the city.' },
  bellward: {
    name: 'Bellward',
    description: 'Civic stonework, the records office, and the Archive.',
  },
  hook: {
    name: 'the Hook',
    description: 'Working docks, the ferry, and sheltered rooms by the river.',
  },
  tanglefoot: {
    name: 'Tanglefoot',
    description: 'Evening company, little shops, and the Bijou movie house.',
  },
  patch: {
    name: 'the Patch',
    description: 'Porches, Pat’s diner, the washhouse, and fresh bread.',
  },
  millrace: {
    name: 'Millrace',
    description: 'Old brick mills, workshops, bowling, the arcade, and the canal walk.',
  },
  sweetwater: {
    name: 'Sweetwater',
    description: 'Gardens, open water, the bathhouse, and places to sit together.',
  },
  fairlawn: {
    name: 'Fairlawn',
    description: 'Tree-lined residential streets and the Easel painting studio.',
  },
  longacre: { name: 'Long Acre', description: 'Fields, orchard paths, woodland, and a campfire.' },
  gravewalk: {
    name: 'the Gravewalk',
    description: 'A quiet, separate part of the world; walking routes may not reach it.',
  },
};

const DIRECTIONS: Record<string, string> = {
  n: 'north',
  s: 'south',
  e: 'east',
  w: 'west',
  ne: 'northeast',
  nw: 'northwest',
  se: 'southeast',
  sw: 'southwest',
  u: 'up',
  d: 'down',
  in: 'in',
  out: 'out',
};

/** Public routes never cross a private home, including an unlocked one. A resident may start inside their own home. */
export function guideRoute(
  rooms: GuideRoom[],
  origin: string,
  target: string,
): { id: string; name: string; direction?: string }[] | null {
  const byId = new Map(
    rooms.filter((r) => !r.props?.home || r.roomId === origin).map((r) => [r.roomId, r]),
  );
  if (!byId.has(origin) || !byId.has(target)) return null;
  const seen = new Map<string, { from: string; direction: string } | null>([[origin, null]]);
  const queue = [origin];
  for (let head = 0; head < queue.length && !seen.has(target); head++) {
    const room = byId.get(queue[head]);
    if (!room) continue;
    for (const [direction, next] of Object.entries(room.exits || {})) {
      if (room.props?.locks?.[direction] || !byId.has(next) || seen.has(next)) continue;
      seen.set(next, { from: room.roomId, direction });
      queue.push(next);
    }
  }
  if (!seen.has(target)) return null;
  const path: { id: string; name: string; direction?: string }[] = [];
  let id = target;
  while (true) {
    const previous = seen.get(id);
    path.unshift({
      id,
      name: byId.get(id)!.name,
      ...(previous ? { direction: previous.direction } : {}),
    });
    if (!previous) return path;
    id = previous.from;
  }
}

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .trim()
    .replace(/^the\s+/, '')
    .replace(/[_-]/g, ' ');
export function guideMatches(rooms: GuideRoom[], query: string): GuideRoom[] {
  const q = normalize(query);
  if (!q) return [];
  const publicRooms = rooms.filter(
    (room) => !room.props?.home && Object.prototype.hasOwnProperty.call(GUIDE_WARDS, room.district),
  );
  const exact = publicRooms.filter(
    (room) => normalize(room.roomId) === q || normalize(room.name) === q,
  );
  return exact.length
    ? exact
    : publicRooms.filter(
        (room) => normalize(room.name).includes(q) || normalize(room.roomId).includes(q),
      );
}

const ACTIVITIES = [
  {
    room: 'foundry_court',
    category: 'make',
    title: 'Canal trail',
    detail: 'Six connected stops, a saved notebook, and no entry fee.',
  },
  {
    room: 'repair_hall',
    category: 'make',
    title: 'Build a bird shelter',
    detail: 'Three steps; choose a style and keep the finished piece. Supplies are free.',
  },
  {
    room: 'glass_canopy',
    category: 'make',
    title: 'Pot an herb cutting',
    detail: 'Choose an herb, prepare its pot, and keep it. Supplies are free.',
  },
  {
    room: 'lock_garden',
    category: 'make',
    title: 'Work the model lock',
    detail: 'Learn the water levels in three untimed steps. Free.',
  },
  {
    room: 'gully_laundry',
    category: 'rest',
    title: 'Read a mystery',
    detail: 'The book exchange saves your page. Free.',
  },
  {
    room: 'net_loft',
    category: 'people',
    title: 'Meet by the river',
    detail: 'A sheltered public sitting room for knots, conversation, and gatherings.',
  },
  {
    room: 'pats_diner',
    category: 'people',
    title: 'Visit Pat’s diner',
    detail: 'Company and work shifts; the food menu shows its price before you eat.',
  },
  {
    room: 'starlite_arcade',
    category: 'play',
    title: 'Visit the arcade',
    detail: 'Pinball, skee-ball, and prizes. Check the game’s price before playing.',
  },
  {
    room: 'the_bijou',
    category: 'play',
    title: 'See what’s at the movies',
    detail: 'Read the bill freely; buying a ticket spends game money.',
  },
  {
    room: 'the_easel',
    category: 'make',
    title: 'Try painting',
    detail: 'Sketch, paint, and browse the gallery. Check supplies and prices there.',
  },
  {
    room: 'alder_trail',
    category: 'nature',
    title: 'Explore the woods',
    detail: 'Wildlife, written photographs, and a field journal; no reaction test.',
  },
  {
    room: 'alder_camp',
    category: 'rest',
    title: 'Rest by the fire',
    detail: 'A free place to recover comfort or share a story.',
  },
  {
    room: 'reed_pavilion',
    category: 'rest',
    title: 'Listen by the river',
    detail: 'Covered benches and reeds; free and unhurried.',
  },
  {
    room: 'sweetwater_bathhouse',
    category: 'play',
    title: 'Visit the bathhouse',
    detail: 'Swimming, sauna, and soaking; the venue explains its entry price.',
  },
] as const;
const CATEGORIES: Record<string, string> = {
  make: 'Make something',
  people: 'Find company',
  play: 'Play and go out',
  nature: 'Explore outdoors',
  rest: 'Rest and read',
};

interface Project {
  name: string;
  room: string;
  location: string;
  steps: { prompt: string; choices: string[]; results: string[]; sound: string }[];
  title(variant: string): string;
  description: string;
  finishes?: string[];
}

export const CANAL_PROJECTS: Record<string, Project> = {
  shelter: {
    name: 'Make a bird shelter',
    room: 'repair_hall',
    location: 'the Repair Hall',
    steps: [
      {
        prompt:
          'Choose a shape for your pre-cut bird shelter. Both shapes work; this is your design.',
        choices: ['A little gabled house', 'An open-front shelter'],
        results: [
          'You lay out a peaked roof and four small cedar walls.',
          'You lay out an open front, a broad roof, and a sheltered back.',
        ],
        sound: 'hangout.page',
      },
      {
        prompt: 'The pieces are clamped at the bench. Smooth them before assembly.',
        choices: ['Sand with the grain', 'Round the entrance edges'],
        results: [
          'Long strokes take the roughness out of the boards.',
          'You work around the entrance until every edge feels smooth.',
        ],
        sound: 'obj.brush.stroke',
      },
      {
        prompt: 'The joints are ready. Choose a finish for the outside.',
        choices: ['Leave the cedar natural', 'Brush on a blue outer roof'],
        results: [
          'The cedar grain stays visible beneath the little roof.',
          'You brush a blue roof while keeping the inside untreated.',
        ],
        sound: 'work.hammer.build',
      },
    ],
    title: (variant) => (variant === '1' ? 'an open-front bird shelter' : 'a gabled bird shelter'),
    description:
      'A cedar bird shelter you assembled at the Repair Hall. Its smooth edges and sturdy joints are your own work.',
    finishes: [
      'The outside shows the natural cedar grain.',
      'The roof is painted blue; the inside is untreated cedar.',
    ],
  },
  herbs: {
    name: 'Pot an herb cutting',
    room: 'glass_canopy',
    location: 'the Glass Canopy',
    steps: [
      {
        prompt: 'Choose a rooted cutting from the nursery tray.',
        choices: ['Mint', 'Rosemary', 'Lemon balm'],
        results: [
          'The mint cutting has fine white roots beneath its square stem.',
          'The rosemary cutting smells resinous, even before you touch a leaf.',
          'The lemon balm has soft leaves with a citrus scent.',
        ],
        sound: 'hangout.page',
      },
      {
        prompt: 'Prepare the pot so the roots have room and water can drain.',
        choices: ['Loosen the compost with a scoop', 'Crumble the compost by hand'],
        results: [
          'You loosen the compost and check the drainage hole.',
          'You feel out the clumps, break them apart, and check the drainage hole.',
        ],
        sound: 'hangout.page',
      },
      {
        prompt: 'Settle the cutting into its new pot.',
        choices: ['Water gently and add a raised label', 'Water gently and add a written label'],
        results: [
          'Water settles the soil. A raised label identifies your herb by touch.',
          'Water settles the soil. You write a clear label for your herb.',
        ],
        sound: 'obj.water.pour.glass',
      },
    ],
    title: (variant) =>
      ['a potted mint cutting', 'a potted rosemary cutting', 'a potted lemon balm cutting'][
        Number(variant)
      ] || 'a potted herb cutting',
    description:
      'A rooted herb cutting you potted beneath the Glass Canopy, with loose compost, drainage, and a label.',
    finishes: [
      'Its raised label can be read by touch.',
      'Its written label identifies the herb clearly.',
    ],
  },
  lock: {
    name: 'Work the model lock',
    room: 'lock_garden',
    location: 'the Lock Garden',
    steps: [
      {
        prompt:
          'A toy boat waits on the lower side. The chamber is at the lower water level. Let the boat enter.',
        choices: ['Open the lower gate'],
        results: ['The toy boat floats into the chamber at the same water level.'],
        sound: 'splash',
      },
      {
        prompt: 'The boat is inside. The upper water is higher. Prepare to raise the boat.',
        choices: ['Close the lower gate, then open the small fill valve'],
        results: ['Water enters slowly. The boat rises with it, staying level.'],
        sound: 'obj.water.pour.glass',
      },
      {
        prompt: 'The chamber and upper canal are now level.',
        choices: ['Close the valve and open the upper gate'],
        results: [
          'The toy boat glides out onto the upper canal. Matching the levels is what makes the gates safe to open.',
        ],
        sound: 'splash',
      },
    ],
    title: () => 'a canal keeper’s sketch',
    description:
      'Your labeled drawing of a model lock: enter at the lower level, close the gate and fill, then leave at the upper level.',
  },
};

const success = (lines: string[], choices: Choice[] = []): GuideResult => ({
  ok: true,
  lines,
  choices,
});

const projectDescription = (project: Project, state: GuideProjectState): string =>
  [project.description, state.finish === undefined ? '' : project.finishes?.[state.finish]]
    .filter(Boolean)
    .join(' ');

function routeView(rooms: GuideRoom[], origin: string, target: GuideRoom): GuideResult {
  const path = guideRoute(rooms, origin, target.roomId);
  if (!path)
    return success(
      [
        `There is no open public walking route to ${target.name} from here. An exit may be locked, or this place may need another form of travel.`,
      ],
      [{ label: 'Town guide', cmd: 'town' }],
    );
  if (path.length === 1)
    return success(
      [`You are at ${target.name}. Choose an activity here or pick another destination.`],
      [
        { label: 'What can I do here?', cmd: 'what' },
        { label: 'Town guide', cmd: 'town' },
      ],
    );
  const summary = `${target.name} is ${path.length - 1} ${path.length === 2 ? 'step' : 'steps'} away. First go ${DIRECTIONS[path[1].direction!] || path[1].direction} to ${path[1].name}.`;
  return {
    ...success(
      [
        summary,
        'Your destination is saved. Walk one step at a time, explore along the way, and use Route to pick up where you left off. No travel fee.',
        ...path
          .slice(1)
          .map(
            (step, i) =>
              `${i + 1}. ${DIRECTIONS[step.direction!] || step.direction} to ${step.name}.`,
          ),
      ],
      [
        {
          label: `Walk ${DIRECTIONS[path[1].direction!] || path[1].direction} to ${path[1].name}`,
          cmd: 'walk route',
        },
        { label: 'Stop following this route', cmd: 'route clear' },
        { label: 'Town guide', cmd: 'town' },
      ],
    ),
    guide: { title: `Route to ${target.name}`, summary, current: origin, stops: path },
  };
}

export async function runReverieGuide(
  store: GuideStore,
  origin: string,
  command: string,
  arg = '',
): Promise<GuideResult> {
  const rooms = await store.rooms();
  const current = rooms.find((room) => room.roomId === origin);
  const state = await store.state();
  if (command === 'route' || command === 'walk route') {
    if (arg === 'clear') {
      await store.destination('');
      return success(['The route is put away. You can still explore freely.']);
    }
    const query = arg || state.destination || '';
    if (!query)
      return success(
        ['Choose a destination in the town guide, or type route followed by a place name.'],
        [{ label: 'Town guide', cmd: 'town' }],
      );
    const matches = guideMatches(rooms, query);
    if (matches.length !== 1)
      return success(
        [
          matches.length
            ? 'Several public places match. Choose the one you mean.'
            : 'No public place matches that name. Try the town guide.',
        ],
        matches.slice(0, 24).map((room) => ({ label: room.name, cmd: `route ${room.roomId}` })),
      );
    const target = matches[0];
    if (command === 'walk route') {
      const path = guideRoute(rooms, origin, target.roomId);
      if (!path || path.length < 2) return routeView(rooms, origin, target);
      const result = await store.walk(path[1].direction!);
      if (result.ok)
        result.lines.push(
          path.length === 2
            ? `You have reached ${target.name}.`
            : `Continue toward ${target.name} when you are ready: choose Route.`,
        );
      return result;
    }
    if (!(await store.destination(target.roomId)))
      return { ok: false, lines: ['Your location changed. Look again before choosing a route.'] };
    return routeView(rooms, origin, target);
  }
  if (command === 'notebook' || command === 'canal trail') {
    const done = CANAL_STOPS.filter((stop) => state.notes?.[stop.id]);
    const next = CANAL_STOPS.find((stop) => !state.notes?.[stop.id]);
    const lines = [
      `Canal notebook: ${done.length} of ${CANAL_STOPS.length} stops recorded.`,
      'A free walk from Millrace through the old canal to Sweetwater. Visit in any order. Read or examine the feature at each stop to save its entry; simply arriving does not finish it. Your place is saved when you leave.',
      ...done.map((stop) => `${stop.name}: ${stop.note}`),
      ...(done.length === CANAL_STOPS.length
        ? [
            'Canal trail complete. Your notebook now tells the whole water story, from the mills to the gardens.',
          ]
        : []),
      ...Object.entries(state.projects || {})
        .filter(([id, p]) => Object.prototype.hasOwnProperty.call(CANAL_PROJECTS, id) && p.finished)
        .map(
          ([id, p]) =>
            `Made: ${CANAL_PROJECTS[id].title(p.variant)}. It is yours to carry, drop, or keep.`,
        ),
    ];
    return success(lines, [
      ...(next
        ? [
            {
              label: `Next stop: ${next.name}`,
              cmd: next.id === origin ? next.command : `route ${next.id}`,
            },
          ]
        : []),
      ...CANAL_STOPS.map((stop) => ({
        label: `${state.notes?.[stop.id] ? 'Recorded' : 'Explore'}: ${stop.name}`,
        cmd: stop.id === origin ? stop.command : `route ${stop.id}`,
      })),
      { label: 'Workshop projects', cmd: 'projects' },
    ]);
  }
  if (command === 'projects')
    return success(
      [
        'Three free projects. Supplies are provided; no timer, skill level, or money is required. Each step is saved. Finished pieces go into your inventory.',
      ],
      Object.entries(CANAL_PROJECTS).map(([id, p]) => ({
        label: `${p.name} — ${p.location}${state.projects?.[id]?.finished ? ' (finished)' : ''}`,
        cmd: `project ${id}`,
      })),
    );
  if (command === 'project') {
    const [id, stageText, optionText] = arg.split(/\s+/);
    const project = Object.prototype.hasOwnProperty.call(CANAL_PROJECTS, id)
      ? CANAL_PROJECTS[id]
      : null;
    if (!project)
      return success(
        ['Choose one of the workshop projects.'],
        [{ label: 'Projects', cmd: 'projects' }],
      );
    if (origin !== project.room)
      return success(
        [
          `${project.name} is at ${project.location}. Your progress stays saved while you are away.`,
        ],
        [{ label: `Directions to ${project.location}`, cmd: `route ${project.room}` }],
      );
    const before = state.projects?.[id] || { stage: 0, variant: '0' };
    if (before.finished) {
      await store.deliver(id, project.title(before.variant), projectDescription(project, before));
      return success(
        [
          `You finished ${project.title(before.variant)}. Your notebook keeps the record; check your inventory, or wherever you left the piece.`,
        ],
        [
          { label: 'Inventory', cmd: 'inventory' },
          { label: 'Notebook', cmd: 'notebook' },
        ],
      );
    }
    const step = project.steps[before.stage];
    if (!step)
      return { ok: false, lines: ['This project needs a fresh look. Open Projects again.'] };
    if (stageText === undefined)
      return success(
        [`${project.name}: step ${before.stage + 1} of ${project.steps.length}. ${step.prompt}`],
        step.choices.map((label, i) => ({ label, cmd: `project ${id} ${before.stage} ${i}` })),
      );
    const option = Number(optionText);
    if (
      stageText !== String(before.stage) ||
      !/^\d$/.test(optionText || '') ||
      !step.choices[option]
    )
      return success(
        [
          'That choice belongs to an earlier step, or is not one of the available options. Your saved work is safe.',
        ],
        [{ label: 'Continue the saved project', cmd: `project ${id}` }],
      );
    const after: GuideProjectState = {
      stage: before.stage + 1,
      variant: before.stage === 0 ? String(option) : before.variant,
      finished: before.stage + 1 === project.steps.length,
      ...(before.stage + 1 === project.steps.length ? { finish: option } : {}),
    };
    if (!(await store.project(id, before.stage, after)))
      return {
        ok: false,
        lines: [
          'That step was already handled, or you moved away. Open the project to read your saved progress.',
        ],
        choices: [{ label: 'Read project progress', cmd: `project ${id}` }],
      };
    if (after.finished)
      await store.deliver(id, project.title(after.variant), projectDescription(project, after));
    await store.announce(
      after.finished
        ? `finishes ${project.title(after.variant)}.`
        : `works on ${project.name.toLowerCase()}.`,
      step.sound,
    );
    return {
      ...success(
        [
          step.results[option],
          after.finished
            ? `Finished: ${project.title(after.variant)}. The piece is in your inventory and the record is in your notebook.`
            : `Step ${after.stage} saved. You can leave and continue later.`,
        ],
        [
          {
            label: after.finished ? 'Read my notebook' : 'Continue project',
            cmd: after.finished ? 'notebook' : `project ${id}`,
          },
        ],
      ),
      kinds: [step.sound],
    };
  }
  if (arg === 'start')
    return success(
      [
        'You live here at your own pace. There is no required story order, and leaving the game does not punish you.',
        'Use the connected place buttons to walk. Town guide tells you why to go somewhere; Route gives one clear step at a time.',
        'Here with you lists people in this room. Choose a name for conversation and other actions. What can I do here lists local activities.',
        'Wants give you optional goals. Your status shows comfort and game money. Read a menu before choosing an action with a price.',
        'For a first outing, try the free Canal trail: six stops, three projects, a saved notebook, and no timed challenges.',
      ],
      [
        { label: 'Start the Canal trail', cmd: 'canal trail' },
        { label: 'My wants', cmd: 'wants' },
        { label: 'What can I do here?', cmd: 'what' },
      ],
    );
  if (arg === 'wards')
    return success(
      ['Choose a neighborhood. Each guide lists actual public places; private homes stay private.'],
      Object.entries(GUIDE_WARDS).map(([id, ward]) => ({
        label: `${ward.name} — ${ward.description}`,
        cmd: `town ${id}`,
      })),
    );
  if (Object.prototype.hasOwnProperty.call(GUIDE_WARDS, arg)) {
    const places = rooms
      .filter((room) => room.district === arg && !room.props?.home)
      .sort((a, b) => a.name.localeCompare(b.name));
    return success(
      [`${GUIDE_WARDS[arg].name}: ${GUIDE_WARDS[arg].description}`],
      places.map((room) => ({ label: room.name, cmd: `route ${room.roomId}` })),
    );
  }
  if (Object.prototype.hasOwnProperty.call(CATEGORIES, arg)) {
    const available = new Set(rooms.filter((room) => !room.props?.home).map((room) => room.roomId));
    const rows = ACTIVITIES.filter(
      (activity) => activity.category === arg && available.has(activity.room),
    );
    return success(
      [CATEGORIES[arg], ...rows.map((row) => `${row.title}: ${row.detail}`)],
      rows.map((row) => {
        const path = guideRoute(rooms, origin, row.room);
        return {
          label: `${row.title} — ${path ? (path.length === 1 ? 'here' : `${path.length - 1} steps`) : 'no open walking route'}`,
          cmd: `route ${row.room}`,
        };
      }),
    );
  }
  return success(
    [
      `Town guide. You are ${current ? `at ${current.name}, in ${GUIDE_WARDS[current.district]?.name || current.district}` : 'in Reverie'}.`,
      'Choose what you feel like doing. Every destination has directions. The Canal trail and workshop projects are free; other venues show their prices before purchases.',
      ...(state.destination
        ? [`You have a saved route. Choose Route to continue from where you are now.`]
        : []),
    ],
    [
      { label: 'Getting started', cmd: 'town start' },
      { label: 'Canal trail — six stops, free', cmd: 'canal trail' },
      { label: 'My notebook and projects', cmd: 'notebook' },
      ...Object.entries(CATEGORIES).map(([id, label]) => ({ label, cmd: `town ${id}` })),
      { label: 'Browse neighborhoods', cmd: 'town wards' },
      ...(state.destination ? [{ label: 'Continue my route', cmd: 'route' }] : []),
    ],
  );
}
