// Pure presentation rules shared by the renderer and its regression checks.
export function sceneModel(room, hud = {}) {
  const id = String(room.roomId || '');
  const senses = room.sensory || {};
  const nature = !!senses.nature;
  const water = !!senses.water || /pier|dock|breakwater|pilings|houseboat/.test(id);
  const type = room.home
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
              : /archive|records|book/.test(id)
                ? 'library'
                : 'interior';
  return {
    id,
    type,
    name: String(room.name || 'Reverie'),
    dark: !!hud.dark,
    weather: String(hud.weather || room.weather || 'clear'),
    outdoor: !!room.outdoor,
    furniture: (room.furniture || []).slice(0, 24),
    people: [
      {
        id: hud.characterId || 'self',
        name: hud.name || 'You',
        kind: 'player',
        self: true,
        appearance: hud.appearance,
      },
      ...(room.peopleDetail || []).toSorted((a, b) => String(a.id).localeCompare(String(b.id))),
    ].slice(0, 12),
    totalPeople: 1 + (room.peopleDetail || []).length,
    hangout: room.hangout ? { title: room.hangout.title, guests: room.hangout.guests || [] } : null,
  };
}

export function describePicture(model) {
  const settings = {
    home: 'a cutaway home with an open front, wooden floorboards, and a window',
    camp: 'a woodland clearing with a stone fire ring, log seats, and a covered picnic table',
    creek: 'a winding blue-green creek, rounded stones, reeds, and layered trees',
    woodland: 'a curving earth path between layered trees, ferns, and small flowers',
    harbor: 'a wooden waterfront deck beside blue-green water, with mooring posts and a railing',
    town: 'a cobbled square with colorful building fronts, planters, benches, and street lamps',
    diner: 'a cutaway diner with tiled floors, a counter, red stools, and booth seats',
    library: 'a cutaway reading room with tall bookshelves and a reading table',
    bar: 'a cutaway neighborhood bar with an amber counter, stools, bottle shelves, and a dartboard',
    bowling: 'a cutaway bowling alley with polished wooden lanes, pins, ball returns, and bench seating',
    laundry: 'a cutaway laundromat with round washing-machine doors, a folding table, and baskets',
    office: 'a cutaway records office with file cabinets, a paper-covered desk, and a reading lamp',
    interior: 'a cutaway room with a wooden floor and warm wall lights',
  };
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
    `Figures in view: ${crowd}.` +
    model.people.filter(p => p.tag).map(p => figurePosition(model, p, model.people.indexOf(p)).gathering
      ? ` ${p.name} is taking part in the gathering.` : ` ${p.name} is ${p.tag}.`).join('') +
    (model.totalPeople > 12
      ? ` ${model.totalPeople - 12} more occupants remain listed in Here with you.`
      : '') +
    furniture +
    (['diner', 'interior', 'library'].includes(model.type)
      ? ' A framed painting shows an imagined riverside town, a stone bridge, and apricot clouds reflected in teal water.'
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
    'Small gestures and held objects illustrate visible activities; they do not change the world or signal game outcomes. ' +
    'Saved build, hair, and clothing choices shape the figures; custom clothing is simplified, and colors and unchosen details are artistic. Other figures remain stylized stand-ins. The scenery is an artistic layout; use the room description and exits for navigation.'
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
  const hair = look.hair || '';
  const style = look.style || '';
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
    hairColor: /gray/.test(hair) ? 0xbcbab1 : 0x433c36,
    outfit: /dress/.test(style)
      ? 'dress'
      : /coat|suit|church/.test(style)
        ? 'coat'
        : /coveralls/.test(style)
          ? 'coveralls'
          : 'shirt',
    headphones: /headphones/.test(style),
    skin: [0xc28f68, 0x805c45, 0xe5b48d, 0xa46c4c, 0xf1ceaa][seed % 5],
    shirt: [0xcd8665, 0x537f8a, 0xd0b678, 0x88779a, 0x719b84][(seed >>> 4) % 5],
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

export function furnitureKind(name) {
  const n = String(name).toLowerCase();
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
  const tag = String(person.tag || '').toLowerCase();
  if (/\b(not|never)\b/.test(tag)) return 'idle';
  if (/grill|cook|baking/.test(tag)) return 'cooking';
  if (/tea|coffee|pour|polishing glasses|behind the bar/.test(tag)) return 'drinking';
  if (/read|book|stacks|keeping the quiet|paper|filing/.test(tag)) return 'reading';
  if (/sweep|mop|clean/.test(tag)) return 'sweeping';
  if (/haul|crates|carrying/.test(tag)) return 'carrying';
  if (/fishing|casting/.test(tag)) return 'fishing';
  if (/dance|dancing/.test(tag)) return 'dance';
  return 'idle';
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
  return pose;
}
