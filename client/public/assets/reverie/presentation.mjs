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
      { id: 'self', name: hud.name || 'You', kind: 'player' },
      ...(room.peopleDetail || []),
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
    (model.totalPeople > 12
      ? ` ${model.totalPeople - 12} more occupants remain listed in Here with you.`
      : '') +
    furniture +
    (['diner', 'interior', 'library'].includes(model.type)
      ? ' A framed painting shows an imagined riverside town, a stone bridge, and apricot clouds reflected in teal water.'
      : '') +
    ' Figures are stylized stand-ins, not chosen character appearances. The scenery is an artistic layout; use the room description and exits for navigation.'
  );
}

export function hash(value) {
  let n = 2166136261;
  for (const c of String(value)) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  return n >>> 0;
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
