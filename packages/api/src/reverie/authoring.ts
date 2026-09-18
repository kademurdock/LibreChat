export interface AuthoredPlace {
  roomId: string;
  name: string;
  district: string;
  desc: string;
  exits: Record<string, string>;
  props: {
    outdoor: boolean;
    surface: string;
    smell: string;
    listenLine: string;
    doings: string;
    sound?: string;
    water?: string;
    sleepable: boolean;
  };
}
export interface AuthoredAction {
  roomId: string;
  command: string;
  label: string;
  line: string;
  sound: string;
  event: string;
}
export interface AuthoredWorld {
  places: AuthoredPlace[];
  actions: AuthoredAction[];
  links: { roomId: string; direction: string; destination: string }[];
}
const directions: Record<string, string> = {
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
  northeast: 'ne',
  northwest: 'nw',
  southeast: 'se',
  southwest: 'sw',
  up: 'u',
  down: 'd',
  in: 'in',
  out: 'out',
};
const wards = new Set([
  'hook',
  'sweetwater',
  'patch',
  'bellward',
  'longacre',
  'millrace',
  'tanglefoot',
  'fairlawn',
  'gravewalk',
  'gate',
]);
const identifier = /^[a-z][a-z0-9_]{1,59}$/;

/** Deliberately small, data-only language. No script evaluation, interpolation, or arbitrary effects. */
export function compileReverie(source: string): AuthoredWorld {
  if (source.length > 100_000) throw new Error('World source exceeds 100,000 characters.');
  const world: AuthoredWorld = { places: [], actions: [], links: [] };
  let current: AuthoredPlace | undefined;
  const ids = new Set<string>();
  const fields = new Set<string>();
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const fail = (message: string): never => {
      throw new Error(`Line ${index + 1}: ${message}`);
    };
    const place = /^Place ([a-z0-9_]+) in ([a-z]+)\.$/.exec(line);
    if (place) {
      const [, roomId, district] = place;
      if (!identifier.test(roomId) || ids.has(roomId) || !wards.has(district))
        fail('Invalid or duplicate place, or unknown ward.');
      ids.add(roomId);
      fields.clear();
      current = {
        roomId,
        district,
        name: '',
        desc: '',
        exits: {},
        props: {
          outdoor: false,
          surface: 'wood.interior',
          smell: '',
          listenLine: '',
          doings: '',
          sleepable: true,
        },
      };
      world.places.push(current);
      continue;
    }
    const link = /^Link ([a-z0-9_]+) ([a-z]+) to ([a-z0-9_]+)\.$/.exec(line);
    if (link) {
      const [, roomId, direction, destination] = link;
      if (
        !identifier.test(roomId) ||
        !identifier.test(destination) ||
        !Object.hasOwn(directions, direction)
      )
        fail('Invalid link.');
      if (
        world.links.some(
          (item) => item.roomId === roomId && item.direction === directions[direction],
        )
      )
        fail('Duplicate link direction.');
      world.links.push({ roomId, direction: directions[direction], destination });
      continue;
    }
    if (!current) fail('Start with Place <id> in <ward>.');
    const property = /^([A-Za-z]+): (.+)$/.exec(line);
    if (!property) fail('Expected a named field followed by a colon.');
    const key = property![1].toLowerCase();
    const value = property![2].trim();
    if (value.length > 2000) fail('Field is too long.');
    if (fields.has(key) && key !== 'action') fail('Duplicate field.');
    fields.add(key);
    const room = current!;
    if (Object.hasOwn(directions, key)) {
      if (!identifier.test(value)) fail('Exit must name a place id.');
      room.exits[directions[key]] = value;
    } else if (key === 'name') room.name = value;
    else if (key === 'description') room.desc = value;
    else if (key === 'outside') {
      if (!['yes', 'no'].includes(value)) fail('Outside must be yes or no.');
      room.props.outdoor = value === 'yes';
    } else if (key === 'ground') {
      if (
        ![
          'wood.interior',
          'cobble',
          'grass.dry',
          'dirt.packed',
          'linoleum',
          'carpet',
          'metal.stair',
        ].includes(value)
      )
        fail('Unknown ground material.');
      room.props.surface = value;
    } else if (key === 'smell') room.props.smell = value;
    else if (key === 'listen') room.props.listenLine = value;
    else if (key === 'doings') room.props.doings = value;
    else if (key === 'ambience') {
      if (!/^amb\.[a-z0-9.]+$/.test(value)) fail('Ambience must name an amb. sound.');
      room.props.sound = value;
    } else if (key === 'water') {
      if (!['river', 'harbor', 'lake'].includes(value)) fail('Unknown water type.');
      room.props.water = value;
    } else if (key === 'action') {
      const pieces = value.split('|').map((piece) => piece.trim());
      if (pieces.length !== 5 || pieces.some((piece) => !piece))
        fail('Action needs command | button label | personal result | sound | public action.');
      const [command, label, result, sound, event] = pieces;
      if (!/^[a-z][a-z ]{2,49}$/.test(command) || !/^[a-z][a-z0-9.]+$/.test(sound))
        fail('Invalid command or sound id.');
      if (world.actions.some((action) => action.command === command)) fail('Duplicate command.');
      world.actions.push({ roomId: room.roomId, command, label, line: result, sound, event });
    } else fail(`Unknown field: ${key}.`);
  }
  for (const place of world.places) {
    if (
      !place.name ||
      !place.desc ||
      !place.props.smell ||
      !place.props.listenLine ||
      !Object.keys(place.exits).length
    )
      throw new Error(
        `${place.roomId}: name, description, smell, listen, and at least one exit are required.`,
      );
  }
  return world;
}
