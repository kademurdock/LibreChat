import type { FamilyFact, FamilyMedia, FamilyPlace } from './history';
import type { FamilyImage, FamilyPersonCard } from './present';
import { familyImage, familyNamed, familyPersonCard, familySay } from './present';
import type { FamilyPageContext } from './pages';
import { familyFollowsText, familyShortPlace, familySubject } from './pages';
import { familyLanes } from './layout';
import { FAMILY_HISTORY_EVENTS, familyCapital, familyList } from './words';
import { familyDate, familyMediaVisible, own } from './util';

/* ----------------------------------------------------------------------------
 * FAMILY HISTORY: WHERE AND WHEN (docs/FAMILY_HISTORY.md, "/timeline", "/places")
 *
 * The timeline runs newest decade first: each decade says how many of the
 * viewer's ancestors (or relatives) were alive, what national history they
 * lived through, their lifelines in lanes packed here, and what happened to
 * them. The map answers from the export's offline places (a fixed set of at
 * most 80, towns merged into counties) and says "not ready" until they exist.
 * Living relatives appear like anyone (the owner's decision).
 * THE REPOSITORY IS PUBLIC: no family data belongs here.
 * -------------------------------------------------------------------------- */

export type FamilyScope = 'ancestors' | 'all';

const EVENT_TYPES: ReadonlySet<string> = new Set([
  'BIRT',
  'DEAT',
  'BURI',
  'MARR',
  'RESI',
  'CENS',
  'IMMI',
  'EMIG',
  'NATU',
  '_MILT',
  'OCCU',
  'DIV',
]);

function inScope(ctx: FamilyPageContext, scope: FamilyScope): string[] {
  const out: string[] = [];
  for (const id of Object.keys(ctx.lens.view.relations)) {
    const person = own(ctx.bundle.people, id);
    if (!person || person.duplicateOf) continue;
    const relation = ctx.lens.relation(id);
    if (!relation) continue;
    if (scope === 'ancestors' ? relation.group === 'ancestor' : relation.group !== 'self')
      out.push(id);
  }
  return out.sort((a, b) => ctx.lens.near(a) - ctx.lens.near(b) || (a < b ? -1 : 1));
}

function word(scope: FamilyScope, n: number): string {
  if (scope === 'ancestors') return n === 1 ? 'ancestor' : 'ancestors';
  return n === 1 ? 'relative' : 'relatives';
}

/** "was counted in the census in Town" for one fact. */
function happened(fact: FamilyFact, spouseName: string | null): string {
  const place = familyShortPlace(fact.place);
  const at = place ? ` in ${place}` : '';
  const value = String(fact.value || '').trim();
  switch (fact.type) {
    case 'BIRT':
      return `was born${at}`;
    case 'DEAT':
      return `died${at}`;
    case 'BURI':
      return `was buried${at}`;
    case 'MARR':
      return `married${spouseName ? ` ${spouseName}` : ''}${at}`;
    case 'DIV':
      return `was divorced${at}`;
    case 'RESI':
      return place ? `lived in ${place}` : 'was recorded at home';
    case 'CENS':
      return `was counted in the census${at}`;
    case 'IMMI':
      return `arrived as an immigrant${at}`;
    case 'EMIG':
      return `left to emigrate${at}`;
    case 'NATU':
      return `became a citizen${at}`;
    case '_MILT':
      return `served in the military${value ? `, ${value}` : ''}${at}`;
    case 'OCCU':
      return value ? `worked as ${value}` : `was working${at}`;
    default:
      return `${(fact.label || 'had an event').toLowerCase()}${at}`;
  }
}

/** GET /timeline: decades newest first. */
export function familyTimelinePayload(
  ctx: FamilyPageContext,
  scope: FamilyScope,
): Record<string, unknown> {
  const ids = inScope(ctx, scope);
  const thisYear = Math.max(new Date(ctx.now).getUTCFullYear(), ctx.model.thisYear);
  const life = new Map<string, { from: number | null; to: number | null }>();
  for (const id of ids) {
    const born = ctx.model.born(id).year;
    const living = !!own(ctx.bundle.people, id)?.living;
    const died = living ? thisYear : ctx.model.died(id).year;
    life.set(id, { from: born, to: died });
  }
  const bars = ids
    .map((id) => ({ id, ...(life.get(id) as { from: number | null; to: number | null }) }))
    .filter(
      (bar): bar is { id: string; from: number; to: number } =>
        bar.from != null && bar.to != null && bar.to >= bar.from,
    );
  const packed = familyLanes(bars);
  const years = bars.map((bar) => bar.from);
  const factYears: number[] = [];
  for (const id of ids)
    for (const fact of own(ctx.bundle.people, id)?.facts || []) {
      const year = familyDate(fact.date).year;
      if (year != null && EVENT_TYPES.has(fact.type)) factYears.push(year);
    }
  const earliest = Math.min(...years, ...factYears, thisYear);
  const first = Math.floor(earliest / 10) * 10;
  const last = Math.floor(thisYear / 10) * 10;
  const people: Record<string, FamilyPersonCard> = {};
  const cardOf = (id: string): FamilyPersonCard | null => {
    const card = familyPersonCard(ctx.pc, id);
    if (card) people[id] = card;
    return card;
  };
  /* photos by decade: portraits and family photos of people in scope, nearest relative first */
  const photos = new Map<number, { item: FamilyMedia; near: number }>();
  for (const mediaId of Object.keys(ctx.bundle.media)) {
    const item = ctx.bundle.media[mediaId];
    if (
      item.kind === 'restored' ||
      !ctx.model.servable(item) ||
      !familyMediaVisible(ctx.bundle, item, ctx.pc.audience)
    )
      continue;
    const category = ctx.model.category(item);
    if (category !== 'portrait' && category !== 'photo') continue;
    const year = familyDate(item.date).year;
    if (year == null) continue;
    const linked = (item.people || []).filter((p) => life.has(p));
    if (!linked.length) continue;
    const near = Math.min(...linked.map(ctx.lens.near));
    const decade = Math.floor(year / 10) * 10;
    const best = photos.get(decade);
    if (!best || near < best.near) photos.set(decade, { item, near });
  }
  const events = new Map<number, Record<string, unknown>[]>();
  for (const id of ids) {
    const person = own(ctx.bundle.people, id);
    for (const fact of person?.facts || []) {
      if (!EVENT_TYPES.has(fact.type)) continue;
      const year = familyDate(fact.date).year;
      if (year == null) continue;
      const spouse =
        fact.type === 'MARR'
          ? (person?.spouses || [])
              .map((s) => own(ctx.bundle.people, s))
              .find((s) => (s?.facts || []).some((f) => f.type === 'MARR' && f.date === fact.date))
              ?.name || null
          : null;
      const subject = familySubject(ctx, id);
      const what = happened(fact, spouse);
      const text = `${year}: ${subject.words} ${subject.self ? what.replace(/^was /, 'were ') : what}.`;
      const decade = Math.floor(year / 10) * 10;
      const list = events.get(decade) || [];
      list.push({
        year,
        text,
        spoken: familySay(text),
        personId: id,
        research: !!ctx.lens.research(id),
      });
      events.set(decade, list);
    }
  }
  const decades: Record<string, unknown>[] = [];
  for (let decade = last; decade >= first; decade -= 10) {
    const end = decade + 9;
    const alive = bars.filter((bar) => bar.from <= end && bar.to >= decade);
    const context: Record<string, unknown>[] = [];
    for (const event of FAMILY_HISTORY_EVENTS) {
      if (event.from < decade || event.from > end) continue;
      const adults = bars.filter((bar) => bar.from <= event.to - 18 && bar.to >= event.from).length;
      if (!adults) continue;
      let text = event.line(adults, ctx.lens.voice.poss);
      if (scope === 'all')
        text = text.replace(/\bancestors\b/, 'relatives').replace(/\bancestor\b/, 'relative');
      context.push({ key: event.key, title: event.title, text, spoken: familySay(text) });
    }
    const list = (events.get(decade) || []).sort((a, b) => (a.year as number) - (b.year as number));
    if (!alive.length && !list.length && !context.length) continue;
    const photo = photos.get(decade);
    const image: FamilyImage | null = photo
      ? familyImage(ctx.pc, photo.item.id, { prefer: 'restored' })
      : null;
    const summary = `${alive.length} of ${ctx.lens.voice.poss} ${word(scope, 2)} ${alive.length === 1 ? 'was' : 'were'} alive.`;
    for (const bar of alive) cardOf(bar.id);
    for (const event of list) cardOf(event.personId as string);
    decades.push({
      decade,
      title: `${decade}s`,
      summary,
      spoken: familySay(
        `${decade}s: ${alive.length} ${word(scope, alive.length)} alive, ${list.length} ${list.length === 1 ? 'event' : 'events'}`,
      ),
      photo: image,
      bars: alive.map((bar) => ({
        id: bar.id,
        lane: packed.lane.get(bar.id) || 0,
        from: bar.from,
        to: bar.to,
        side: ctx.lens.side(bar.id),
        research: !!ctx.lens.research(bar.id),
      })),
      context,
      events: list,
    });
  }
  const follows = ctx.lens.view.follows || null;
  return {
    scope,
    title:
      scope === 'ancestors' ? `${familyCapital(ctx.lens.voice.poss)} ancestors` : 'All relatives',
    top: ctx.lens.voice.borrowed ? `${ctx.ownerFirst}, today` : 'You, today',
    hint: 'Scroll down to go back in time.',
    follows: familyFollowsText(follows, ctx.lens.voice),
    lanes: packed.lanes,
    mapReady: familyPlacesReady(ctx),
    people,
    decades,
  };
}

/** True when the export's map has places. */
export function familyPlacesReady(ctx: FamilyPageContext): boolean {
  return (
    !!ctx.bundle.places &&
    Array.isArray(ctx.bundle.places.places) &&
    ctx.bundle.places.places.length > 0
  );
}

function placeWords(place: FamilyPlace): string {
  if (place.precision === 'state') return `somewhere in ${place.short}`;
  if (place.precision === 'country') return `somewhere in ${place.short}`;
  return place.short;
}

/** GET /places, or null while the export has no map. */
export function familyPlacesPayload(
  ctx: FamilyPageContext,
  scope: FamilyScope,
): Record<string, unknown> | null {
  const block = ctx.bundle.places;
  if (!block || !familyPlacesReady(ctx)) return null;
  const ids = new Set(inScope(ctx, scope));
  const places = new Map<string, FamilyPlace>();
  for (const place of block.places)
    if (place && typeof place.id === 'string') places.set(place.id, place);
  const stays = (block.stays || []).filter(
    (s) => ids.has(s.p) && places.has(s.pl) && typeof s.y === 'number',
  );
  const people: Record<string, FamilyPersonCard> = {};
  const cardOf = (id: string): void => {
    const card = familyPersonCard(ctx.pc, id);
    if (card) people[id] = card;
  };
  const byDecade = new Map<number, Map<string, Set<string>>>();
  for (const stay of stays) {
    const decade = Math.floor(stay.y / 10) * 10;
    const at = byDecade.get(decade) || new Map<string, Set<string>>();
    const who = at.get(stay.pl) || new Set<string>();
    who.add(stay.p);
    at.set(stay.pl, who);
    byDecade.set(decade, at);
  }
  const w = (n: number): string => word(scope, n);
  const decades: Record<string, unknown>[] = [];
  let start: number | null = null;
  let richest = -1;
  for (const decade of [...byDecade.keys()].sort((a, b) => a - b)) {
    const at = byDecade.get(decade) as Map<string, Set<string>>;
    const counts: Record<string, number> = {};
    const everyone = new Set<string>();
    for (const [placeId, who] of at) {
      counts[placeId] = who.size;
      who.forEach((id) => everyone.add(id));
    }
    const ranked = [...at.keys()].sort(
      (a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b),
    );
    const regions = new Map<
      string,
      { heading: string; rows: Record<string, unknown>[]; count: number }
    >();
    for (const placeId of ranked) {
      const place = places.get(placeId) as FamilyPlace;
      const heading =
        place.precision === 'country' || !place.state
          ? place.country || place.short
          : (place.precision === 'state' ? place.short : stateName(block.places, place.state)) ||
            place.short;
      const group = regions.get(heading) || { heading, rows: [], count: 0 };
      const n = counts[placeId];
      group.count += n;
      group.rows.push({
        placeId,
        text: `${familyCapital(placeWords(place))}: ${n} ${w(n)}`,
        people: [...(at.get(placeId) as Set<string>)],
      });
      regions.set(heading, group);
    }
    const list = [...regions.values()].sort(
      (a, b) => b.count - a.count || a.heading.localeCompare(b.heading),
    );
    const moves = (block.moves || [])
      .filter(
        (m) =>
          ids.has(m.p) &&
          m.y >= decade &&
          m.y <= decade + 9 &&
          places.has(m.from) &&
          places.has(m.to),
      )
      .map((m) => ({ personId: m.p, from: m.from, to: m.to, year: m.y }));
    everyone.forEach(cardOf);
    const summary = `${everyone.size} ${w(everyone.size)} in ${at.size} ${at.size === 1 ? 'place' : 'places'}`;
    const top = list.slice(0, 2).map((g) => g.heading);
    decades.push({
      decade,
      title: `${decade}s`,
      summary,
      spoken: familySay(
        `${decade}s: ${summary}${top.length ? `, most in ${familyList(top)}` : ''}${moves.length ? `, ${moves.length} ${moves.length === 1 ? 'move' : 'moves'}` : ''}. The list below names every place.`,
      ),
      counts,
      labels: ranked.slice(0, 5),
      moves,
      list: list.map(({ heading, rows }) => ({ heading, rows })),
    });
    if (everyone.size > richest) {
      richest = everyone.size;
      start = decade;
    }
  }
  const ocean = (block.ocean || [])
    .filter((o) => ids.has(o.p) && places.has(o.from) && places.has(o.to))
    .map((o) => {
      const from = places.get(o.from) as FamilyPlace;
      const to = places.get(o.to) as FamilyPlace;
      cardOf(o.p);
      const text = `${familySubject(ctx, o.p).words} came from ${o.country || from.short} about ${o.y}.`;
      return {
        personId: o.p,
        text,
        spoken: familySay(text),
        from: { lat: from.lat, lon: from.lon, name: from.short },
        to: { lat: to.lat, lon: to.lon, name: to.short },
      };
    });
  const journeys: Record<string, unknown>[] = [];
  const byPerson = new Map<string, typeof stays>();
  for (const stay of stays) {
    const list = byPerson.get(stay.p) || [];
    list.push(stay);
    byPerson.set(stay.p, list);
  }
  for (const id of [...byPerson.keys()].sort(
    (a, b) => ctx.lens.near(a) - ctx.lens.near(b) || (a < b ? -1 : 1),
  )) {
    const list = (byPerson.get(id) || [])
      .slice()
      .sort((a, b) => a.y - b.y || (a.t === 'BIRT' ? -1 : 1));
    const legs: string[] = [];
    let previous = '';
    for (const stay of list) {
      if (stay.pl === previous) continue;
      const place = placeWords(places.get(stay.pl) as FamilyPlace);
      legs.push(
        !legs.length && stay.t === 'BIRT'
          ? `born in ${place} in ${stay.y}`
          : `in ${place} by ${stay.y}`,
      );
      previous = stay.pl;
    }
    if (legs.length < 2) continue;
    cardOf(id);
    const text = `${familyCapital(familyNamed(ctx.pc, id))}: ${legs.join(', ')}.`;
    journeys.push({ personId: id, text, spoken: familySay(text) });
    if (journeys.length >= 60) break;
  }
  const placed = new Set(stays.map((s) => s.p));
  const unplacedCount = [...ids].filter((id) => !placed.has(id)).length;
  return {
    scope,
    places: block.places.map((p) => ({
      id: p.id,
      short: p.short,
      lat: p.lat,
      lon: p.lon,
      precision: p.precision,
    })),
    people,
    start,
    decades,
    ocean,
    journeys,
    unplaced: unplacedCount
      ? `${unplacedCount} ${w(unplacedCount)} ${unplacedCount === 1 ? 'has' : 'have'} no place in the records yet.`
      : null,
    note: block.note || 'Places come from records. Some records give only a state.',
  };
}

function stateName(all: FamilyPlace[], state: string): string | null {
  const place = all.find((p) => p.precision === 'state' && p.state === state);
  return place ? place.short : state;
}
