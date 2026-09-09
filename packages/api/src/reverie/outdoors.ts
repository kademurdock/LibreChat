export interface SensoryRoom {
  roomId: string;
  district?: string;
  props?: {
    outdoor?: boolean;
    home?: object;
    surface?: string;
    water?: string;
    sound?: string;
    habitat?: string;
  };
}

export function reverieSenses(
  room: SensoryRoom,
  weather = 'clear',
  dark = false,
): {
  surface: string;
  footstep: string;
  ambience: string | null;
  nature: boolean;
  water: string | null;
  texture: string;
} {
  const id = room.roomId;
  const p = room.props || {};
  const wet = ['rain', 'storm'].includes(weather);
  const nature = p.habitat || (/orchard|fields|garden|park|greenhouse/.test(id) ? 'garden' : '');
  let surface = 'wood.interior';
  if (p.outdoor) surface = 'cobble';
  if (nature) surface = 'grass.dry';
  if (/archive|records|office/.test(id)) surface = 'carpet';
  if (/diner|hospital|clinic|store|salon/.test(id)) surface = 'linoleum';
  if (/stairs|garages|salvage/.test(id)) surface = 'metal.stair';
  if (/pier|dock|pilings|boardwalk/.test(id) || p.home) surface = 'wood.interior';
  if (p.surface) surface = p.surface;
  if (wet && p.outdoor) {
    if (['dirt.packed', 'grass.dry'].includes(surface)) surface = 'mud.shallow';
    else if (surface === 'cobble') surface = 'asphalt.wet';
  }
  let ambience: string | null = null;
  if (nature) ambience = dark ? 'amb.woods.night' : 'amb.woods.day';
  if (id === 'reedbank_creek') ambience = 'amb.creek.bank';
  if (id === 'alder_camp') ambience = 'amb.camp.fire';
  if (/archive|records/.test(id)) ambience = 'amb.archive.quiet';
  if (/diner|kettle/.test(id)) ambience = 'amb.diner.quiet';
  if (p.home) ambience = 'amb.home.quiet';
  if (id === 'gully_laundry') ambience = 'amb.laundry.quiet';
  const texture: { [key: string]: string } = {
    'wood.interior': 'Wooden boards give a little underfoot.',
    carpet: 'Carpet softens your steps.',
    'metal.stair': 'Metal rings briefly beneath your feet.',
    linoleum: 'Your soles brush the smooth floor.',
    'grass.dry': 'Grass brushes your ankles.',
    'dirt.packed': 'Firm earth, with loose leaves along the edge.',
    'mud.shallow': 'The wet ground gives softly beneath your feet.',
    'asphalt.wet': 'A thin film of rain splashes underfoot.',
    cobble: 'Uneven stone presses through your soles.',
  };
  return {
    surface,
    footstep: `move.step.${surface}`,
    ambience,
    nature: !!nature,
    water: p.water || null,
    texture: texture[surface] || 'The ground feels firm beneath your feet.',
  };
}

interface OutdoorRoom extends SensoryRoom {
  name: string;
  desc: string;
  exits: { [direction: string]: string };
  props: NonNullable<SensoryRoom['props']> & {
    forage?: boolean;
    smell: string;
    listenLine: string;
    doings: string;
    sleepable?: boolean;
  };
}
export const REVERIE_OUTDOORS: OutdoorRoom[] = [
  {
    roomId: 'alder_trail',
    name: 'Alder Trail',
    district: 'longacre',
    desc: 'Leaves shuffle above a narrow earth path. The air smells of damp bark. A low rail guides the bend toward the creek; the orchard is back south. A path east leads to a sheltered fire ring, and a small hide stands west among the trees.',
    exits: { s: 'tandy_orchard', n: 'reedbank_creek', e: 'alder_camp', w: 'alder_hide' },
    props: {
      outdoor: true,
      surface: 'dirt.packed',
      habitat: 'woods',
      forage: true,
      smell: 'Damp bark, crushed leaves, and an occasional windfall apple.',
      listenLine: 'Leaves moving overhead. Small birds answer from either side of the path.',
      doings: 'Explore the trail. Track wildlife. Forage. Follow the creek north.',
    },
  },
  {
    roomId: 'reedbank_creek',
    name: 'Reedbank Creek',
    district: 'longacre',
    desc: 'Clear water slips over rounded stones. A level patch of bank gives you room to sit with a fishing pole. Reeds brush each other at the bend. The trail leads south, and a wooden boardwalk east reaches the lake dock.',
    exits: { s: 'alder_trail', e: 'the_lake_dock' },
    props: {
      outdoor: true,
      surface: 'dirt.packed',
      habitat: 'creek',
      water: 'river',
      forage: true,
      smell: 'Cool water, wet stone, and green reeds.',
      listenLine: 'Water trickles over stones close by; reeds hiss at the bend.',
      doings: 'Try easy fishing with a loaner pole. Listen to the creek. Track wildlife.',
    },
  },
  {
    roomId: 'alder_camp',
    name: 'Alder Camp',
    district: 'longacre',
    desc: 'A small tended fire crackles inside a stone ring. There are log seats and a covered picnic table. Woodsmoke hangs below the alder branches. The trail is west; you can always find it by the rail.',
    exits: { w: 'alder_trail' },
    props: {
      outdoor: true,
      surface: 'grass.dry',
      habitat: 'woods',
      sleepable: true,
      smell: 'Woodsmoke, dry logs, and somebody’s tea.',
      listenLine: 'Low flames rustle and twigs pop inside the fire ring.',
      doings: 'Rest by the fire. Start a shared story circle or cookout. Track wildlife.',
    },
  },
  {
    roomId: 'alder_hide',
    name: 'Alder Hide',
    district: 'longacre',
    desc: 'A wooden shelter faces a clearing full of grass and seed heads. Narrow openings let you watch without crowding the animals. A trail marker identifies this as the small-game ground. The path back east is clear.',
    exits: { e: 'alder_trail' },
    props: {
      outdoor: true,
      surface: 'wood.interior',
      habitat: 'hide',
      smell: 'Dry wood and warm grass.',
      listenLine: 'Grass rustles at the edge of the clearing; wings flutter above the roof.',
      doings: 'Watch or photograph wildlife. Optional small-game bow hunting starts with hunt.',
    },
  },
];

export function outdoorEncounter(
  activity: string,
  turn: number,
  dark: boolean,
): { line: string; sound: string; fun: number; rested: number; skill: string } {
  if (activity === 'rest by fire')
    return {
      line: 'You settle on a log by the fire. Warmth reaches your knees; the air at your back stays cool. You take your time.',
      sound: 'hangout.seat',
      fun: 6,
      rested: 12,
      skill: 'care',
    };
  const encounters = dark
    ? [
        'A rabbit pauses at the edge of the clearing. You hear two light hops before it disappears into the grass.',
        'An owl turns on a branch above the trail. A feather catches the pale light, then the bird settles again.',
        'Something small rustles through the leaves. You follow the sound to a trail of narrow paw prints.',
      ]
    : [
        'A rabbit nibbles clover beside the trail. Its ears turn toward you, then relax when you keep still.',
        'A wren hops along the rail with a twig in its beak. You wait while it finds its way through the branches.',
        'A deer’s paired hoofprints cross a soft patch of earth. You follow them as far as the creek, where the trail fades.',
        'A squirrel works at a fallen seed head. Tiny flakes patter onto the leaves below it.',
      ];
  return {
    line:
      encounters[turn % encounters.length] +
      (activity === 'photograph wildlife'
        ? ' You save a field photograph in your journal.'
        : ' You add the sighting to your field journal.'),
    sound: 'hangout.page',
    fun: 7,
    rested: 0,
    skill: 'learning',
  };
}
