// Pure presentation rules shared by the renderer and its regression checks.
export function wardArchitecture(district) {
  const styles = {
    gate: { colors: [0x9cae9a, 0xc4aa7c, 0x879f9a], detail: 'arch', description: 'pale stone arches and green gatehouses' },
    bellward: { colors: [0xbcb7a1, 0xb8ad98, 0x939d9a], detail: 'clock', description: 'tall civic stone buildings and a square clock tower' },
    hook: { colors: [0x647c88, 0x9c735b, 0x828d91], detail: 'sheds', description: 'weathered dock sheds, broad loading doors, and rope rails' },
    tanglefoot: { colors: [0x815f78, 0xad725b, 0x6c8589], detail: 'signs', description: 'closely packed shops with striped awnings and glowing signs' },
    patch: { colors: [0xc6a27c, 0x9bab91, 0xc28272], detail: 'porches', description: 'low timber houses with porches and shared front steps' },
    millrace: { colors: [0xa2654c, 0x995f4c, 0x858778], detail: 'mills', description: 'red-brick mills with high windows, sawtooth rooflines, and a chimney' },
    sweetwater: { colors: [0xc8d1b8, 0x85a99b, 0xb9c393], detail: 'gardens', description: 'light garden pavilions, planted borders, and green trellises' },
    fairlawn: { colors: [0xd8c5a0, 0xb9c8b5, 0xc7b2a7], detail: 'fences', description: 'detached pastel houses, neat fences, and broad front gardens' },
    longacre: { colors: [0xa97554, 0xb4a179, 0x82947a], detail: 'barns', description: 'low farm buildings with broad pitched roofs and a water tank' },
    gravewalk: { colors: [0x8c9294, 0x747c83, 0xa3a49a], detail: 'arch', description: 'quiet stone walls and weathered arches' },
  };
  return styles[district] || styles.gate;
}
export function sceneModel(room, hud = {}) {
  const id = String(room.roomId || '');
  const senses = room.sensory || {};
  const nature = !!senses.nature;
  const water = !!senses.water || /pier|dock|breakwater|pilings|houseboat/.test(id);
  /* Part 296: five new places draw their own rooms, and a yard built onto a
   * home is a yard. The server names the scene; the ids are the fallback. */
  const venue = VENUE_SCENES[id] || (SCENE_TYPES.has(room.scene) ? room.scene : null);
  const type = venue ? venue : id === 'reed_pavilion' ? 'pavilion' : id === 'net_loft' ? 'netloft' : room.home && room.home.roomType === 'yard' ? 'yard' : room.home
    ? 'home'
    : id === 'alder_camp'
      ? 'camp'
      : nature
        ? water
          ? 'creek'
          : 'woodland'
        : water && room.outdoor
          ? 'harbor'
          : room.outdoor
            ? 'town'
            : /bowl/.test(id)
              ? 'bowling'
              : /bar$|dezs_bar/.test(id)
                ? 'bar'
                : /laundr/.test(id)
                  ? 'laundry'
                  : /records_office|bureau/.test(id)
                    ? 'office'
            : /diner|kettle|truck_stop/.test(id)
              ? 'diner'
              : /levis_chairs/.test(id)
                ? 'barber'
                : /the_garages/.test(id)
                  ? 'workshop'
              : /archive|records|book/.test(id)
                ? 'library'
                : 'interior';
  return {
    id,
    type,
    district: String(room.district || 'gate'),
    architecture: wardArchitecture(room.district),
    name: String(room.name || 'Reverie'),
    exits: (room.exitsDetail || []).map((exit) => ({ dir: exit.dir, label: exit.label, to: exit.to, locked: !!exit.locked, missing: !!exit.missing, returning: !!exit.returning })),
    dark: !!hud.dark,
    weather: String(hud.weather || room.weather || 'clear'),
    outdoor: !!room.outdoor,
    washhouse: type === 'laundry' ? { benchStage: Math.max(0, Math.min(3, Number(room.washhouse?.benchStage) || 0)) } : null,
    furniture: (room.furniture || []).slice(0, 24),
    style: room.style ? { walls: String(room.style.walls || ''), wallHex: String(room.style.wallHex || ''), floor: String(room.style.floor || ''), floorKind: String(room.style.floorKind || '') } : null,
    roomType: room.home ? room.home.roomType || 'main' : null,
    paintings: (room.paintings || []).slice(0, 12).map((p) => ({ title: String(p.title || ''), painter: String(p.painter || ''), medium: String(p.medium || '') })),
    people: [
      {
        id: hud.characterId || 'self',
        name: hud.name || 'You',
        kind: 'player',
        self: true,
        appearance: hud.appearance,
      },
      /* SORT BY NAME, NOT BY ID (the Veil, Sep 21 2026). Ids beginning `npc:`
       * sort into a contiguous block, so the citizens always stood together in
       * the same part of the picture and in the same stretch of the read-out
       * order. A block is an answer too. Names interleave. */
      ...(room.peopleDetail || []).toSorted((a, b) =>
        String(a.name || '').localeCompare(String(b.name || '')) ||
        String(a.id).localeCompare(String(b.id))),
    ].slice(0, 12),
    totalPeople: 1 + (room.peopleDetail || []).length,
    hangout: room.hangout ? { title: room.hangout.title, guests: room.hangout.guests || [] } : null,
  };
}

const VENUE_SCENES = { the_bijou: 'theater', starlite_arcade: 'arcade', early_bird_bakery: 'bakery', sweetwater_bathhouse: 'pool', the_easel: 'studio', foundry_court: 'foundry', repair_hall: 'repairhall', canal_towpath: 'towpath', lock_garden: 'lockgarden', glass_canopy: 'glasshouse', canal_overlook: 'overlook' };
const SCENE_TYPES = new Set(['theater', 'arcade', 'bakery', 'pool', 'studio']);

export function describePicture(model) {
  const settings = {
    foundry: 'a brick foundry courtyard with a tall chimney, workshop windows, a timber table, and a raised noticeboard',
    repairhall: 'a cutaway brick workshop with tall windows, two wooden workbenches at different heights, labeled hand tools, and a partly assembled bird shelter',
    towpath: 'a long brick towpath beside a narrow blue-green mill channel, with a continuous rail, benches, and water-level markers',
    lockgarden: 'a water garden in an old lock, with paired timber gates, reeds, a low sill, and a miniature lock on a public table',
    glasshouse: 'an iron-and-glass canopy with open vents, long potting benches, terracotta pots, and rows of green herbs around a broad aisle',
    overlook: 'a broad stone terrace with a raised canal model, backed benches, a continuous rail, and the waterway below',
    theater: 'a cutaway movie house with sloping rows of red seats, gold curtains, a popcorn machine, and a big glowing screen',
    arcade: 'a cutaway arcade with dark blue carpet dotted with little planets, glowing pinball machines, a glass claw machine full of plush animals, and two skee-ball lanes',
    bakery: 'a cutaway bakery with a brick oven glowing orange, glass cases of bread and cinnamon buns, a counter with a register, and a chalkboard',
    pool: 'a cutaway bathhouse with a long blue-green pool and lane ropes, a tall lifeguard chair, a bubbling hot tub, and a cedar sauna door',
    studio: 'a cutaway painting studio with easels, a long paint-spattered table, tall windows, and a gallery wall of framed paintings',
    yard: 'a small fenced yard with grass, a clothesline, and a young tree',
    pavilion: 'a roofed riverside platform with open sides, facing benches, reeds, and a framed estuary painting',
    netloft: 'a wooden public sitting room with broad river windows, rope coils, a worktable, and an estuary painting',
    home: 'a cutaway home with an open front, wooden floorboards, and a window',
    camp: 'a woodland clearing with a stone fire ring, log seats, and a covered picnic table',
    creek: 'a winding blue-green creek, rounded stones, reeds, and layered trees',
    woodland: 'a curving earth path between layered trees, ferns, and small flowers',
    harbor: 'a wooden waterfront deck beside blue-green water, with mooring posts and a railing',
    town: 'a cobbled street with ' + (model.architecture?.description || 'colorful building fronts') + ', planters, benches, and street lamps',
    diner: 'a cutaway diner with tiled floors, a counter, red stools, and booth seats',
    library: 'a cutaway reading room with tall bookshelves and a reading table',
    bar: 'a cutaway neighborhood bar with an amber counter, stools, bottle shelves, and a dartboard',
    bowling: 'a cutaway bowling alley with polished wooden lanes, pins, ball returns, and bench seating',
    laundry: 'a cutaway laundromat with pale green linoleum, round washing-machine doors, a folding table, a blue button tin, a window bench, and a small book shelf',
    office: 'a cutaway records office with file cabinets, a paper-covered desk, and a reading lamp',
    barber: 'a cutaway barbershop with a mirror, a barber chair, combs, towels, and waiting seats',
    workshop: 'a cutaway workshop with a tool board, a workbench, stacked tires, and a rolling stool',
    interior: 'a cutaway room with a wooden floor and warm wall lights',
  };
  const styled = model.style && (model.style.walls || model.style.floor)
    ? ` ${model.style.walls ? `The walls are painted ${model.style.walls}` : 'The walls keep their plain color'}${model.style.floor ? `, and the floor is ${model.style.floor}` : ''}.`
    : '';
  const hung = model.paintings && model.paintings.length
    ? ` Framed paintings hang on the wall: ${model.paintings.map((p) => `${p.title}${p.painter ? ` by ${p.painter}` : ''}`).join('; ')}.`
    : '';
  const furniture =
    model.type === 'home'
      ? model.furniture.length
        ? ' Your room furnishings appear as small three-dimensional pieces: ' +
          model.furniture.join(', ') +
          '.'
        : ' The room is unfurnished, matching the game.'
      : '';
  const crowd = model.people.map((p) => p.name).join(', ');
  return (
    `The picture of ${model.name} is a handcrafted miniature seen from above at an angle: ${settings[model.type]}. ` +
    (model.dark
      ? 'The palette is deep blue and teal with amber pools of lamplight. '
      : 'The palette is soft green, terracotta, cream, and honey-colored wood. ') +
    (model.outdoor && ['rain', 'storm', 'snow', 'fog'].includes(model.weather)
      ? `The picture shows the current ${model.weather}. `
      : '') +
    (model.exits?.length ? 'Direction signs name the actual connected rooms: ' + model.exits.map(e => e.label + ' to ' + e.to + (e.locked ? ' (locked)' : '')).join('; ') + '. The signs mark exits, not measured distances. ' : '') +
    `Figures in view: ${crowd}.` +
    model.people.filter(p => p.tag).map(p => figurePosition(model, p, model.people.indexOf(p)).gathering
      ? ` ${p.name} is taking part in the gathering.` : ` ${p.name} is ${p.tag}.`).join('') +
    (model.totalPeople > 12
      ? ` ${model.totalPeople - 12} more occupants remain listed in Here with you.`
      : '') +
    furniture +
    styled +
    hung +
    (model.washhouse ? (model.washhouse.benchStage === 3 ? ' The window bench has been repaired and stands steady.' : ' The window bench is awaiting repairs; a small tool tray sits beside it.') : '') +
    (['diner', 'interior', 'library'].includes(model.type)
      ? ' A framed painting shows an imagined riverside town, a stone bridge, and apricot clouds reflected in teal water.'
      : '') +
    (['pavilion', 'netloft'].includes(model.type)
      ? ' A cutaway roof reveals wooden benches and a framed watercolor of a winding estuary boardwalk beneath a warm evening sky.'
      : '') +
    ' ' +
    model.people
      .filter((p) => p.appearance)
      .map(
        (p) =>
          `${p.name}: ${[p.appearance.build, p.appearance.hair, p.appearance.style].filter(Boolean).join(', ')}.`,
      )
      .join(' ') +
    (model.hangout ? ' Gathering guests stand in a circle facing the shared table. ' : ' ') +
    'Figures blink at different times, glance around, and change their brows and posture with visible activities. Walking figures turn toward their destination. Small gestures and held objects illustrate visible activities; they do not change the world or signal game outcomes. ' +
    'Saved build, hair, and clothing choices shape the figures, including common chosen colors. Custom clothing is simplified and unchosen details are artistic. Other figures remain stylized stand-ins. The scenery is an artistic layout. Tap figures and direction signs, or use the matching labeled people and exit buttons.'
  );
}

export function hash(value) {
  let n = 2166136261;
  for (const c of String(value)) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  return n >>> 0;
}

export function figureAppearance(person) {
  const look = person.appearance || {};
  const build = look.build || '';
  const hair = (look.hair || '').toLowerCase();
  const style = (look.style || '').toLowerCase();
  const seed = hash(person.id || person.name);
  return {
    width: /big|solid|sturdy/.test(build) ? 1.3 : /slight|lean/.test(build) ? 0.82 : 1,
    height: /tall/.test(build) ? 1.18 : /short/.test(build) ? 0.86 : 1,
    hair: /shaved/.test(hair)
      ? 'bald'
      : /hat/.test(hair)
        ? 'hat'
        : /locs|braids/.test(hair)
          ? 'locks'
          : /bun/.test(hair)
            ? 'bun'
            : /long/.test(hair)
              ? 'long'
              : /curls|gray/.test(hair)
                ? 'curls'
                : 'short',
    hairColor: /pink/i.test(hair) ? 0xe888b8 : /purple/i.test(hair) ? 0x9974d4 : /blue/i.test(hair) ? 0x659cdf : /red|ginger/i.test(hair) ? 0xb65c39 : /blond/i.test(hair) ? 0xe7ce85 : /gray|silver|white/i.test(hair) ? 0xbcbab1 : 0x433c36,
    outfit: /dress/.test(style)
      ? 'dress'
      : /coat|suit|church/.test(style)
        ? 'coat'
        : /coveralls/.test(style)
          ? 'coveralls'
          : 'shirt',
    headphones: /headphones/.test(style),
    glasses: /glasses/.test(style),
    apron: /apron/.test(style),
    watch: /watch/.test(style),
    skin: [0xc28f68, 0x805c45, 0xe5b48d, 0xa46c4c, 0xf1ceaa][seed % 5],
    shirt: /pink/.test(style) ? 0xe888b8 : /blue/.test(style) ? 0x537fc3 : /green/.test(style) ? 0x719b84 : /purple/.test(style) ? 0x9974d4 : /red/.test(style) ? 0xc46457 : /yellow/.test(style) ? 0xe5c363 : [0xcd8665, 0x537f8a, 0xd0b678, 0x88779a, 0x719b84][(seed >>> 4) % 5],
  };
}

export function figurePosition(model, person, index) {
  const guests = (model.hangout?.guests || []).filter((g) =>
    model.people.some((p) =>
      typeof g === 'string' ? p.name === g : p.id === g.userId || p.id === g.id,
    ),
  );
  const guest = guests.findIndex((g) =>
    typeof g === 'string' ? g === person.name : g.userId === person.id || g.id === person.id,
  );
  if (guest >= 0) {
    const angle = (guest / Math.max(2, guests.length)) * Math.PI * 2;
    const radius = guests.length > 6 ? 1.6 : 1.15;
    const centerX = model.type === 'creek' ? 3.1 : -2.8;
    return {
      x: centerX + Math.sin(angle) * radius,
      z: 2.7 + Math.cos(angle) * radius,
      rotation: angle + Math.PI,
      gathering: true,
    };
  }
  const spot = venueSpot(model, person, index);
  if (spot) return spot;
  const activity = publicActivity(person);
  const station = activityStation(model.type, activity);
  if (station && !person.self) {
    const peers = model.people.filter(p => !p.self && activityStation(model.type, publicActivity(p)) === station);
    const slot = Math.max(0, peers.indexOf(person));
    return { x: station.x + (slot % 3) * .62, z: station.z + Math.floor(slot / 3) * .7,
      rotation: station.rotation, gathering: false };
  }
  const points =
    model.type === 'creek'
      ? [
          [1, 2],
          [2.5, 1],
          [0.6, 0.2],
          [1, -1],
          [2, -1.7],
        ]
      : [
          [0.4, 1.5],
          [-1.2, 0.2],
          [0.1, 0.1],
          [0.2, -1.5],
          [2.1, 2.8],
          [-2.2, 2.5],
        ];
  const [x, z] = points[index % points.length];
  return {
    x: x + Math.floor(index / points.length) * 0.7,
    z: z + Math.floor(index / points.length) * 0.7,
    rotation: 0.2 + (index % 3) * 0.28,
    gathering: false,
  };
}

/* Part 296 — where people are in the five new places. The keeper of a place
 * is recognised by what the room says they are doing (the same public line
 * everybody reads), never by who they are, so a player behind the counter
 * would stand there too. */
const KEEPER_SPOTS = {
  theater: { re: /ticket|till|booth|projector/, x: -4.25, z: -1.95, rotation: 0 },
  arcade: { re: /flipper|fixing|counter|ticket|machine/, x: -3.2, z: 2.05, rotation: Math.PI },
  pool: { re: /lanes|tall chair|lifeguard|whistle|towel/, x: 4.2, z: -2.2, y: 1.58, rotation: -Math.PI / 2 },
  bakery: { re: /oven|bread|bak|register|pies/, x: -3.2, z: -2.35, rotation: Math.PI },
  studio: { re: /paint|canvas|window|ceiling/, x: -3.35, z: 0.85, rotation: -0.9 },
};
const SEATS = [];
for (const row of [1, 2, 0, 3]) for (const seat of [3, 2, 4, 1, 5, 0, 6]) SEATS.push({ x: -2.3 + seat * 0.95 + (row % 2) * 0.2, z: -1.3 + row * 1.25 + 0.06, y: 0.06 + row * 0.1 });
const VENUE_POINTS = {
  arcade: [[-3.8, -2.3, Math.PI], [-2.3, -2.3, Math.PI], [-0.8, -2.3, Math.PI], [3.6, -1.75, Math.PI], [0.6, 2.95, Math.PI], [2.1, 2.95, Math.PI], [-1.8, 2.2, Math.PI], [1.4, -0.5, 0.4]],
  bakery: [[0.2, 0.15, Math.PI], [1.2, 0.2, Math.PI], [2.2, 0.15, Math.PI], [3.1, 0.35, Math.PI], [0.4, 3.2, 0.3], [-1.6, 1.6, -0.4]],
  studio: [[2.6, -0.45, Math.PI - 0.3], [3.8, 1.95, Math.PI - 0.5], [-1.2, 2.75, Math.PI], [-0.2, 2.7, Math.PI], [0.9, -2.9, Math.PI], [2.4, 3.2, 0.3]],
  pool: [[-3.6, 2.7, 0.3], [-2.2, 2.9, 0.1], [-0.6, 2.9, 0], [1, 2.9, -0.1], [2.4, 3.1, -0.3], [-4.3, 0.2, Math.PI / 2], [4.3, 0.6, -Math.PI / 2]],
};
function venueSpot(model, person, index) {
  const type = model.type;
  const keeper = KEEPER_SPOTS[type];
  const tag = String(person.tag || '').toLowerCase();
  if (keeper && !person.self && keeper.re.test(tag)) return { x: keeper.x, z: keeper.z, y: keeper.y || 0, rotation: keeper.rotation, gathering: false };
  if (type === 'theater') {
    const s = SEATS[index % SEATS.length];
    return { x: s.x, z: s.z, y: s.y, rotation: Math.PI, gathering: false, seated: true };
  }
  if (type === 'pool' && /swim|lap|paddl|float|cannonball|dripping/.test(tag)) {
    return { x: -2.4 + (index % 5) * 1.2, z: -1.95 + (index % 3) * 1.4, y: -0.38, rotation: Math.PI / 2, gathering: false, swimming: true };
  }
  const points = VENUE_POINTS[type];
  if (!points) return null;
  const [x, z, rotation] = points[index % points.length];
  const lap = Math.floor(index / points.length) * 0.5;
  return { x: x + lap, z: z + lap, rotation, gathering: false };
}

export function furnitureKind(name) {
  const n = String(name).toLowerCase();
  if (/^a painting:/.test(n)) return 'painting';
  for (const [needle, kind] of [['lava lamp', 'lavalamp'], ['fish tank', 'fishtank'], ['bunk', 'bunk'], ['television', 'tv'], ['scratching post', 'post'], ['telescope', 'telescope'], ['jukebox', 'jukebox'], ['hammock', 'hammock'], ['easel', 'easel'], ['shower', 'shower']]) {
    if (n.includes(needle)) return kind;
  }
  for (const kind of [
    'bed',
    'sofa',
    'couch',
    'chair',
    'table',
    'shelf',
    'bookcase',
    'lamp',
    'plant',
    'stove',
    'fridge',
    'radio',
    'rug',
    'crib',
  ]) {
    if (n.includes(kind)) return kind === 'couch' ? 'sofa' : kind === 'bookcase' ? 'shelf' : kind;
  }
  return 'cabinet';
}

export function figureActivity(model, person) {
  if (figurePosition(model, person, Math.max(0, model.people.indexOf(person))).gathering)
    return /story/i.test(model.hangout?.title || '') ? 'reading' : 'talking';
  return publicActivity(person);
}

function publicActivity(person) {
  const tag = String(person.tag || '').toLowerCase();
  if (/\b(not|never)\b/.test(tag)) return 'idle';
  if (/grill|cook|baking/.test(tag)) return 'cooking';
  if (/tea|coffee|pour|polishing glasses|behind the bar/.test(tag)) return 'drinking';
  if (/read|book|stacks|keeping the quiet|paper|filing/.test(tag)) return 'reading';
  if (/sweep|mop|clean/.test(tag)) return 'sweeping';
  if (/wash.*cup|wiping/.test(tag)) return 'washing';
  if (/stretch/.test(tag)) return 'stretching';
  if (/breather|rest|settled|sitting/.test(tag)) return 'resting';
  if (/haul|crates|carrying/.test(tag)) return 'carrying';
  if (/fishing|casting/.test(tag)) return 'fishing';
  if (/dance|dancing/.test(tag)) return 'dance';
  return 'idle';
}

const STATIONS = {
  diner: { cooking: { x: -4.65, z: -1.2, rotation: Math.PI / 2 }, washing: { x: -4.65, z: .2, rotation: Math.PI / 2 } },
  bar: { drinking: { x: -.7, z: .65, rotation: Math.PI }, washing: { x: 0, z: -2.5, rotation: 0 } },
  library: { reading: { x: .5, z: 1.45, rotation: Math.PI } },
  office: { reading: { x: -2, z: .3, rotation: Math.PI } },
  creek: { fishing: { x: 1.25, z: 1.6, rotation: -Math.PI / 2 } },
};
function activityStation(type, activity) { return STATIONS[type]?.[activity]; }

export function residentFace(activity, time, seed = 0) {
  const t = Number.isFinite(time) && time >= 0 ? time : 0;
  const period = 3.8 + (seed % 19) / 10;
  const phase = (t + (seed % 97) / 23) % period;
  const blink = phase > period - .19 ? Math.sin((phase - period + .19) / .19 * Math.PI) : 0;
  const focused = ['reading', 'cooking', 'washing', 'fishing'].includes(activity);
  const cheerful = ['talking', 'dance'].includes(activity);
  return {
    blink: Math.max(0, Math.min(1, blink)),
    gaze: Math.sin(t * .32 + seed % 11) * (focused ? .12 : .55),
    brow: focused ? -.12 : cheerful ? .16 : .04 * Math.sin(t * .6 + seed % 7),
    smile: cheerful ? .65 : activity === 'resting' ? .3 : .08,
    head: focused ? .1 : Math.sin(t * .43 + seed % 13) * .035,
    mouth: cheerful ? .3 + Math.sin(t * 3.2 + seed % 5) * .12 : .12,
  };
}

export function walkPose(from, to, elapsed, seed = 0) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const distance = Math.hypot(dx, dz);
  const duration = Math.max(.55, Math.min(3.5, distance / (1.2 + seed % 7 * .08)));
  const progress = Math.max(0, Math.min(1, Number.isFinite(elapsed) ? elapsed / duration : 1));
  const ease = progress * progress * (3 - 2 * progress);
  const walking = distance > .02 && progress < 1;
  const direction = Math.atan2(dx, dz);
  const turn = Math.atan2(Math.sin(to.rotation - direction), Math.cos(to.rotation - direction));
  return { x: from.x + dx * ease, z: from.z + dz * ease, walking,
    rotation: walking ? direction + turn * Math.max(0, (progress - .75) * 4) : to.rotation,
    stride: walking ? Math.sin(elapsed * (6 + seed % 5 * .3)) * .4 * Math.sin(Math.PI * progress) : 0 };
}

export function activityPose(activity, time, seed = 0) {
  const t = Number.isFinite(time) && time > 0 ? time : 0;
  const phase = t + seed % 7;
  const pose = { left: 0, right: 0, lean: 0, nod: 0 };
  if (activity === 'reading' || activity === 'carrying') { pose.left = -.9; pose.right = -.9; pose.nod = .06; }
  if (activity === 'cooking' || activity === 'sweeping') { pose.right = -.7 + Math.sin(phase * 1.5) * .25; pose.lean = Math.sin(phase) * .035; }
  if (activity === 'drinking') pose.right = -.65 - Math.max(0, Math.sin(phase * .6)) * .8;
  if (activity === 'fishing') { pose.left = -.55; pose.right = -.85 + Math.sin(phase * .8) * .06; }
  if (activity === 'talking') { pose.right = -.3 + Math.sin(phase * 1.3) * .18; pose.nod = Math.sin(phase) * .045; }
  if (activity === 'dance') { pose.left = -.7; pose.right = -.7; pose.lean = Math.sin(phase * 2.4) * .1; }
  if (activity === 'washing') { pose.left = -.7; pose.right = -.8 + Math.sin(phase * 2) * .15; pose.nod = .07; }
  if (activity === 'stretching') { pose.left = -2.1; pose.right = -2.1; pose.lean = Math.sin(phase * .7) * .07; }
  if (activity === 'resting') { pose.left = -.15; pose.right = -.15; pose.nod = .035; }
  return pose;
}
