import type {
  FamilyBundle,
  FamilyFact,
  FamilyHistoryViewer,
  FamilyMedia,
  FamilyPersonPayload,
  FamilyStory,
  FamilyTree,
  FamilyView,
} from './history';
import type { FamilyFindingMeta, FamilyLens, FamilyModel } from './derive';
import { familyBirthPlace, familyDayGap, familyIsoWeek, familyRegion } from './derive';
import type { FamilyLayoutBox } from './layout';
import { familyLayoutTree } from './layout';
import type { FamilyImage, FamilyPersonCard, FamilyPresenter } from './present';
import {
  familyCaption,
  familyImage,
  familyNamed,
  familyPersonCard,
  familyPersonCards,
  familySay,
} from './present';
import type { FamilyCue, FamilyStoryBlock, FamilyStorySource } from './story';
import { familyStoryBlocks, familyStoryChars, familyStoryParts, familySourceLookup } from './story';
import type { FamilyProof, FamilyVoice } from './words';
import { FAMILY_MONTH_NAMES, familyMediaVisible } from './util';
import {
  FAMILY_DESCRIBED_NOTE,
  FAMILY_MYSTERIES_HEADS_UP,
  FAMILY_MYSTERIES_TITLE,
  FAMILY_STORY_RESEARCH_BANNER,
  familyCapital,
  familyDescendantName,
  familyGenerationName,
  familyLadder,
  familyList,
  familyListenTime,
  familyLivedThrough,
  familyNutshell,
  familyPageSpoken,
  familyPercent,
  familyPronouns,
  familyProof,
  familyShare,
  familyTermText,
  familyVoice,
  familyYearText,
} from './words';
import { familyDate, familyFirstName, familyHash, own } from './util';

/* ----------------------------------------------------------------------------
 * FAMILY HISTORY PAGES (docs/FAMILY_HISTORY.md, "v2 routes")
 *
 * The answers for Home, the tree's layout and lists, a person's page, the
 * gallery, a picture's details, findings and stories. Each builder takes one
 * viewer's context and returns plain JSON with every word written here.
 * Featured things (On this day, ancestor of the week, the reel's history
 * cards, news) use only people who have died and who are on no research path
 * and in no sensitive finding; the "It starts with you" and grandparents cards
 * may show living people (the owner's decision).
 * THE REPOSITORY IS PUBLIC: no family data belongs here.
 * -------------------------------------------------------------------------- */

export type FamilyDnaFindings = 'family' | 'owner' | 'off';

export interface FamilyPageContext {
  pc: FamilyPresenter;
  lens: FamilyLens;
  model: FamilyModel;
  bundle: FamilyBundle;
  viewer: FamilyHistoryViewer;
  /** The signed-in account's own first name, for greetings. */
  accountFirst: string;
  ownerFirst: string;
  ownerView: FamilyView | null;
  now: number;
  version: string;
  dnaFindings: FamilyDnaFindings;
  placesReady: boolean;
  listenReady: boolean;
  /** True when a story's file can be served (its path stays in its folder). */
  readable: (story: FamilyStory) => boolean;
}

export interface FamilyOpen {
  to: string;
  id?: string;
  since?: string;
  filter?: string;
}

export interface FamilyTile {
  key: string;
  title: string;
  detail: string;
  spoken: string;
  hint: string;
  enabled: boolean;
  reason: string | null;
  open: FamilyOpen | null;
}

export interface FamilyFindingCard {
  key: string;
  title: string;
  text: string;
  summary: string;
  proof: FamilyProof['level'];
  proofText: string;
  proofSpoken: string;
  people: FamilyPersonCard[];
  evidence: string | null;
  storySlug: string | null;
  dna: boolean;
  spoken: string;
}

const tile = (
  key: string,
  title: string,
  detail: string,
  hint: string,
  open: FamilyOpen | null,
  enabled: boolean = true,
  reason: string | null = null,
): FamilyTile => ({
  key,
  title,
  detail,
  spoken: familySay(`${title}, ${detail}`),
  hint,
  enabled,
  reason,
  open: enabled ? open : null,
});

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A place string without its country when the country is the United States. */
export function familyShortPlace(place: string | null | undefined): string | null {
  const parts = String(place || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  while (
    parts.length > 1 &&
    /^(usa|us|u\.s\.a\.|united states( of america)?)$/i.test(parts[parts.length - 1])
  )
    parts.pop();
  return parts.length ? parts.join(', ') : null;
}

/** Everyone the view calls an ancestor, nearest generation first. */
export function familyAncestors(ctx: FamilyPageContext): string[] {
  const out: string[] = [];
  for (const id of Object.keys(ctx.lens.view.relations)) {
    const person = own(ctx.bundle.people, id);
    if (person && !person.duplicateOf && ctx.lens.isAncestor(id)) out.push(id);
  }
  return out.sort(
    (a, b) =>
      (ctx.lens.relation(a)?.gen || 0) - (ctx.lens.relation(b)?.gen || 0) ||
      ctx.lens.near(a) - ctx.lens.near(b) ||
      (a < b ? -1 : 1),
  );
}

/** Settled for featuring: has died, no research path, no sensitive finding. */
export function familyFeaturable(ctx: FamilyPageContext, id: string): boolean {
  return ctx.model.deceased(id) && !ctx.lens.unsettled(id) && !own(ctx.bundle.people, id)?.virtual;
}

/** The side of the family a half-tree viewer's tree follows, or null when both are there. */
export function familyFollows(model: FamilyModel, personId: string): 'father' | 'mother' | null {
  const parents = model.parents(personId);
  const beyond = (id: string | null): number => (id ? model.line(id).size - 1 : 0);
  const father = beyond(parents.father);
  const mother = beyond(parents.mother);
  if (father > 0 && mother === 0) return 'father';
  if (mother > 0 && father === 0) return 'mother';
  return null;
}

export function familyFollowsText(
  side: 'father' | 'mother' | null,
  voice: FamilyVoice,
): string | null {
  if (!side) return null;
  return `This tree follows ${voice.poss} ${side === 'father' ? 'father' : 'mother'}’s family.`;
}

/** "You're Ada's sister." from the owner's view of this person. */
function youAre(ctx: FamilyPageContext): string {
  if (ctx.viewer.mode === 'owner') return 'This is your tree.';
  if (ctx.viewer.mode === 'guest') return `You’re visiting as ${ctx.ownerFirst}’s guest.`;
  const relation = ctx.ownerView ? own(ctx.ownerView.relations, ctx.viewer.personId) : undefined;
  const ownerVoice = familyVoice(
    ctx.ownerFirst,
    own(ctx.bundle.people, ctx.bundle.owner)?.sex,
    true,
  );
  const term = relation ? familyTermText(relation.term, relation.group, ownerVoice) : null;
  if (!term || term === ownerVoice.self) return `You’re in ${ctx.ownerFirst}’s family tree.`;
  return `You’re ${term.startsWith(ownerVoice.poss) ? '' : 'the '}${term}.`;
}

/** The row words for the Library: "Ada's sister", "Your tree", "Guest". */
export function familyRowDetail(
  mode: FamilyHistoryViewer['mode'],
  ownerFirst: string,
  ownerSex: string | null | undefined,
  relation: { term: string; group: string } | undefined,
): string {
  if (mode === 'owner') return 'Your tree';
  if (mode === 'guest') return 'Guest';
  const term = relation
    ? familyTermText(relation.term, relation.group, familyVoice(ownerFirst, ownerSex, true))
    : null;
  if (!term || term === ownerFirst) return 'In the family tree';
  return familyCapital(term);
}

function photoCount(ctx: FamilyPageContext): number {
  let n = 0;
  for (const id of Object.keys(ctx.bundle.media)) {
    const item = ctx.bundle.media[id];
    if (
      item.kind === 'restored' ||
      !ctx.model.servable(item) ||
      !familyMediaVisible(ctx.bundle, item, ctx.pc.audience)
    )
      continue;
    const category = ctx.model.category(item);
    if (category === 'portrait' || category === 'photo') n++;
  }
  return n;
}

/** Sensitive findings (family mysteries) by KADE_FH_DNA_FINDINGS: `family` (the default) shows
 * them to matched family and the owner, `owner` to the owner alone, `off` to nobody. Guests never. */
export function familyMysteriesAllowed(
  mode: FamilyHistoryViewer['mode'],
  setting: FamilyDnaFindings,
): boolean {
  if (setting === 'off' || mode === 'guest') return false;
  if (setting === 'owner') return mode === 'owner';
  return true;
}

function mysteriesAllowed(ctx: FamilyPageContext): boolean {
  return familyMysteriesAllowed(ctx.viewer.mode, ctx.dnaFindings);
}

/** The DNA tile's words for this viewer, from their own place in the tree (even when their
 * relationships are read from the owner's view). */
export function familyDnaTile(ctx: FamilyPageContext): FamilyTile {
  const hint = 'Where your DNA comes from, on paper, and what the family DNA test found.';
  if (ctx.viewer.mode === 'guest')
    return tile('dna', 'Your DNA', 'For family members in the tree', hint, null, false, 'guest');
  if (ctx.viewer.mode === 'owner')
    return tile('dna', 'Your DNA test', 'What it found, in plain words', hint, { to: 'dna' });
  const sibling = familyIsFullSibling(ctx.bundle, ctx.viewer.personId);
  if (sibling)
    return tile(
      'dna',
      `${ctx.ownerFirst}’s DNA test counts for you too`,
      'Where your DNA comes from',
      hint,
      { to: 'dna' },
    );
  if (ctx.model.line(ctx.viewer.personId).size > 1)
    return tile('dna', 'What you inherited, on paper', 'Where your DNA comes from', hint, {
      to: 'dna',
    });
  const child = (own(ctx.bundle.people, ctx.viewer.personId)?.children || []).find((c) =>
    own(ctx.bundle.people, c),
  );
  if (child)
    return tile('dna', 'Your children’s inheritance', 'What they inherited, on paper', hint, {
      to: 'dna',
      id: child,
    });
  return tile(
    'dna',
    'Your DNA',
    'Your own family isn’t in this tree yet',
    hint,
    null,
    false,
    'married',
  );
}

/** Is this person a full brother or sister of the tree's owner? */
export function familyIsFullSibling(bundle: FamilyBundle, id: string): boolean {
  if (id === bundle.owner) return false;
  const mine = (own(bundle.people, id)?.parents || [])
    .filter((l) => l.kind === 'birth')
    .map((l) => l.id)
    .sort();
  const owners = (own(bundle.people, bundle.owner)?.parents || [])
    .filter((l) => l.kind === 'birth')
    .map((l) => l.id)
    .sort();
  return mine.length === 2 && owners.length === 2 && mine[0] === owners[0] && mine[1] === owners[1];
}

/** The picture for a person in a hero or reel card, restored first. */
export function familyHeroImage(ctx: FamilyPageContext, id: string): FamilyImage | null {
  const mediaId = ctx.model.portrait(id);
  return mediaId ? familyImage(ctx.pc, mediaId, { prefer: 'restored' }) : null;
}

interface FamilyFeatured {
  kind: string;
  title: string;
  text: string;
  spoken: string;
  image: FamilyImage | null;
  open: FamilyOpen;
}

/** The subject of a sentence about someone: "Your father, Ben Example," (the commas set the name
 * off), "You", or just the name when there is no relationship to say. */
export function familySubject(
  ctx: FamilyPageContext,
  id: string,
): { words: string; self: boolean } {
  if (id === ctx.lens.anchor)
    return { words: ctx.lens.voice.selfCapital, self: !ctx.lens.voice.borrowed };
  const named = familyNamed(ctx.pc, id);
  const name = own(ctx.bundle.people, id)?.name || '';
  return { words: named === name ? name : `${familyCapital(named)},`, self: false };
}

function milestoneSentence(
  ctx: FamilyPageContext,
  people: string[],
  type: string,
  place: string | null,
): string {
  const where = place ? ` in ${familyShortPlace(place)}` : '';
  if (type === 'marriage' && people.length === 2) {
    const [a, b] = people;
    const ra = ctx.lens.relation(a);
    const rb = ctx.lens.relation(b);
    if (ra?.group === 'ancestor' && rb?.group === 'ancestor' && ra.gen && ra.gen === rb.gen) {
      const names = familyList(people.map((p) => own(ctx.bundle.people, p)?.name || ''));
      return `${familyCapital(ctx.lens.voice.poss)} ${familyGenerationName(ra.gen).toLowerCase()}, ${names}, married${where}`;
    }
    const other = own(ctx.bundle.people, b)?.name || '';
    return `${familySubject(ctx, a).words} married ${other}${where}`;
  }
  const subject = familySubject(ctx, people[0]);
  const verb =
    type === 'birth'
      ? subject.self
        ? 'were born'
        : 'was born'
      : type === 'death'
        ? 'died'
        : 'married';
  return `${subject.words} ${verb}${where}`;
}

function featured(ctx: FamilyPageContext, ancestors: string[]): FamilyFeatured[] {
  const out: FamilyFeatured[] = [];
  const today = new Date(ctx.now);
  const todayMd = { month: today.getUTCMonth() + 1, day: today.getUTCDate() };
  const onThisDay = ctx.model.milestones
    .map((m) => ({ m, date: familyDate(m.date) }))
    .filter(
      ({ m, date }) =>
        date.month != null &&
        date.day != null &&
        date.year != null &&
        m.people.length > 0 &&
        m.people.every((id) => own(ctx.bundle.people, id) && familyFeaturable(ctx, id)) &&
        m.people.some((id) => ctx.lens.relation(id)) &&
        familyDayGap({ month: date.month, day: date.day }, todayMd) <= 3,
    )
    .sort(
      (a, b) =>
        familyDayGap({ month: a.date.month as number, day: a.date.day as number }, todayMd) -
          familyDayGap({ month: b.date.month as number, day: b.date.day as number }, todayMd) ||
        Math.min(...a.m.people.map(ctx.lens.near)) - Math.min(...b.m.people.map(ctx.lens.near)),
    )[0];
  if (onThisDay) {
    const { m, date } = onThisDay;
    const gap = familyDayGap({ month: date.month as number, day: date.day as number }, todayMd);
    const ago = today.getUTCFullYear() - (date.year as number);
    const when = `${date.day} ${FAMILY_MONTH_NAMES[(date.month as number) - 1]} ${date.year}`;
    const text = `${when}: ${milestoneSentence(ctx, m.people, m.type, m.placeText || null)}. ${ago} years ago ${gap === 0 ? 'today' : 'this week'}.`;
    out.push({
      kind: 'onThisDay',
      title: 'On this day',
      text,
      spoken: familySay(`On this day. ${text}`),
      image: familyHeroImage(ctx, m.people[0]),
      open: { to: 'person', id: m.people[0] },
    });
  }
  const weekly = ancestors.filter((id) => familyFeaturable(ctx, id) && ctx.model.portrait(id));
  if (weekly.length) {
    const sorted = weekly.slice().sort();
    const pick = sorted[parseInt(familyHash(familyIsoWeek(ctx.now), 8), 16) % sorted.length];
    const card = familyPersonCard(ctx.pc, pick) as FamilyPersonCard;
    const lead = `${familyCapital(card.term || card.name)}${card.term ? `, ${card.name}` : ''}${card.years ? `, ${card.years}` : ''}.`;
    const nutshell = personNutshell(ctx, pick);
    const text = nutshell ? `${lead} ${nutshell.split('. ')[0].replace(/\.$/, '')}.` : lead;
    out.push({
      kind: 'ancestorOfWeek',
      title: 'Ancestor of the week',
      text,
      spoken: familySay(`Ancestor of the week. ${text}`),
      image: familyHeroImage(ctx, pick),
      open: { to: 'person', id: pick },
    });
  }
  const stories = ctx.bundle.stories.filter(
    (s) => s.sensitive !== true && s.slug && ctx.readable(s),
  );
  if (stories.length && out.length < 3) {
    const story =
      stories[parseInt(familyHash(`story ${familyIsoWeek(ctx.now)}`, 8), 16) % stories.length];
    const detail = storyDetail(story);
    const text = `${story.title || story.slug}. ${detail}.`;
    out.push({
      kind: 'story',
      title: 'A family story',
      text,
      spoken: familySay(`A family story. ${text}`),
      image: null,
      open: { to: 'story', id: story.slug },
    });
  }
  return out.slice(0, 3);
}

function news(
  ctx: FamilyPageContext,
  since: string | null,
): { text: string; spoken: string; images: FamilyImage[]; open: FamilyOpen } | null {
  if (!since || !Array.isArray(ctx.bundle.changes)) return null;
  const people = new Set<string>();
  const media = new Set<string>();
  for (const change of ctx.bundle.changes) {
    if (
      !change ||
      typeof change.version !== 'string' ||
      change.version <= since ||
      change.version > ctx.version
    )
      continue;
    for (const id of change.people || []) if (own(ctx.bundle.people, id)) people.add(id);
    for (const id of change.media || []) {
      const item = own(ctx.bundle.media, id);
      if (
        item &&
        item.kind !== 'restored' &&
        ctx.model.servable(item) &&
        familyMediaVisible(ctx.bundle, item, ctx.pc.audience)
      )
        media.add(id);
    }
  }
  if (!people.size && !media.size) return null;
  const photos = [...media].filter((id) => {
    const category = ctx.model.category(ctx.bundle.media[id]);
    return category === 'portrait' || category === 'photo';
  });
  const parts: string[] = [];
  if (photos.length) parts.push(count(photos.length, 'new photo', 'new photos'));
  const others = media.size - photos.length;
  if (others) parts.push(count(others, 'new record or document', 'new records and documents'));
  if (people.size) parts.push(count(people.size, 'new person', 'new people'));
  const text = `${familyList(parts)} since your last visit`;
  const images: FamilyImage[] = [];
  for (const id of photos) {
    const linked = ctx.bundle.media[id].people || [];
    if (linked.some((p) => ctx.lens.unsettled(p))) continue;
    const image = familyImage(ctx.pc, id, { prefer: 'restored' });
    if (image) images.push(image);
    if (images.length >= 8) break;
  }
  return { text, spoken: familySay(text), images, open: { to: 'gallery', since, filter: 'all' } };
}

interface FamilyReelCard {
  key: string;
  images: FamilyImage[];
  people: FamilyPersonCard[];
  text: string;
  spoken: string;
  open: FamilyOpen | null;
}

function reel(
  ctx: FamilyPageContext,
  ancestors: string[],
): { title: string; detail: string; cover: FamilyImage | null; cards: FamilyReelCard[] } {
  const voice = ctx.lens.voice;
  const cards: FamilyReelCard[] = [];
  const card = (key: string, text: string, people: string[], open: FamilyOpen | null): void => {
    const images: FamilyImage[] = [];
    for (const id of people) {
      const image = familyHeroImage(ctx, id);
      if (image) images.push(image);
    }
    cards.push({
      key,
      images,
      people: familyPersonCards(ctx.pc, people),
      text,
      spoken: familySay(text),
      open,
    });
  };
  const self = ctx.lens.anchor;
  card(
    'you',
    voice.borrowed
      ? `It starts with ${ctx.ownerFirst}.`
      : `It starts with you, ${ctx.accountFirst}.`,
    [self],
    { to: 'person', id: self },
  );
  const grandparents = ancestors
    .filter((id) => ctx.lens.relation(id)?.gen === 2 && !ctx.lens.unsettled(id))
    .slice(0, 4);
  if (grandparents.length) {
    const names = familyList(
      grandparents.map((id) => familyFirstName(own(ctx.bundle.people, id)?.name)),
    );
    const lead =
      grandparents.length === 1
        ? familyCapital(ctx.lens.term(grandparents[0]) || `${voice.poss} grandparent`)
        : grandparents.length === 4
          ? `${familyCapital(voice.poss)} four grandparents`
          : `${familyCapital(voice.poss)} grandparents`;
    card('grandparents', `${lead}: ${names}.`, grandparents, { to: 'tree' });
  }
  const settled = ancestors.filter((id) => familyFeaturable(ctx, id));
  const dated = settled.filter((id) => ctx.model.born(id).year != null);
  const oldest = dated.sort(
    (a, b) => (ctx.model.born(a).year as number) - (ctx.model.born(b).year as number),
  )[0];
  if (oldest) {
    const born = ctx.model.born(oldest);
    const before = (born.year as number) < 1776 ? ', before there was a United States' : '';
    card(
      'oldest',
      `${familySubject(ctx, oldest).words} was born ${born.approx ? 'about' : 'in'} ${born.year}${before}.`,
      [oldest],
      { to: 'person', id: oldest },
    );
  }
  const abroad = settled
    .map((id) => ({ id, region: familyRegion(familyBirthPlace(own(ctx.bundle.people, id))) }))
    .filter((entry) => entry.region?.abroad)
    .sort((a, b) => (ctx.model.born(a.id).year || 9999) - (ctx.model.born(b.id).year || 9999))[0];
  if (abroad && abroad.region) {
    const born = ctx.model.born(abroad.id);
    const year = familyYearText(born);
    card(
      'ocean',
      `${familySubject(ctx, abroad.id).words} was born in ${abroad.region.name}${year ? `${born.approx ? ' ' : ' in '}${year}` : ''}, across the ocean.`,
      [abroad.id],
      { to: 'person', id: abroad.id },
    );
  }
  const solved = ctx.model.findings.find((f) => !f.sensitive);
  if (solved) {
    const people = solved.people.filter(
      (id) => own(ctx.bundle.people, id) && familyFeaturable(ctx, id),
    );
    card('mystery', `A mystery that was solved: ${solved.title.replace(/[.!?]$/, '')}.`, people, {
      to: 'discoveries',
    });
  }
  const regions = new Map<string, number>();
  let placed = 0;
  for (const id of settled) {
    const region = familyRegion(familyBirthPlace(own(ctx.bundle.people, id)));
    if (!region) continue;
    placed++;
    regions.set(region.name, (regions.get(region.name) || 0) + 1);
  }
  const top = [...regions].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  if (top && placed >= 2) {
    const text =
      top[1] * 5 >= placed * 2
        ? `Most of them were born in ${top[0]}.`
        : `They were born in ${regions.size} states and countries, most often ${top[0]}.`;
    card('places', text, [], ctx.placesReady ? { to: 'map' } : { to: 'whereWhen' });
  }
  card('end', `Explore ${voice.poss} tree.`, [], { to: 'tree' });
  const cover = cards.flatMap((c) => c.images)[0] || null;
  return {
    title: `${familyCapital(voice.poss)} family in 60 seconds`,
    detail: `${cards.length} cards, about a minute`,
    cover,
    cards,
  };
}

/** Everything Home needs in one answer. */
export function familyHomePayload(
  ctx: FamilyPageContext,
  since: string | null,
  ownerExtra: { notes: number; asks: number } | null,
): Record<string, unknown> {
  const voice = ctx.lens.voice;
  const ancestors = familyAncestors(ctx);
  const born = ancestors
    .filter((id) => !own(ctx.bundle.people, id)?.virtual)
    .map((id) => ctx.model.born(id).year)
    .filter((y): y is number => y != null);
  const earliest = born.length ? Math.min(...born) : null;
  const people = Object.keys(ctx.bundle.people).filter(
    (id) => !ctx.bundle.people[id].duplicateOf,
  ).length;
  const hello = `Hi ${ctx.accountFirst}.`;
  const headline = earliest
    ? `${familyCapital(voice.poss)} family goes back to ${earliest}.`
    : `${familyCapital(voice.poss)} family tree.`;
  const stats = `${people} people in the tree, ${ancestors.length} of them ${voice.poss} direct ancestors.`;
  const follows = familyFollowsText(
    ctx.lens.view.follows || familyFollows(ctx.model, ctx.lens.anchor),
    voice,
  );
  const you = youAre(ctx);
  const faces = homeFaces(ctx, ancestors);
  const maxGen = ancestors.reduce((m, id) => Math.max(m, ctx.lens.relation(id)?.gen || 0), 0);
  const findings = ctx.model.findings;
  const discoveries = findings.filter((f) => !f.sensitive).length;
  const mysteries = mysteriesAllowed(ctx) ? findings.filter((f) => f.sensitive).length : 0;
  const guest = ctx.viewer.mode === 'guest';
  const more: FamilyTile[] = [
    tile(
      'stories',
      'Stories',
      count(
        ctx.bundle.stories.filter((story) => ctx.readable(story) && familyStoryAllowed(ctx, story))
          .length,
        'story',
        'stories',
      ),
      'Family stories to read or listen to.',
      { to: 'stories' },
    ),
    tile(
      'discoveries',
      'Discoveries',
      count(discoveries, 'discovery', 'discoveries'),
      'What the research found, with how sure it is.',
      { to: 'discoveries' },
    ),
    ...(mysteries
      ? [
          tile(
            'mysteries',
            FAMILY_MYSTERIES_TITLE,
            FAMILY_MYSTERIES_HEADS_UP,
            'Opens behind a heads-up.',
            { to: 'mysteries' },
          ),
        ]
      : []),
    tile(
      'people',
      'Everyone in the tree',
      count(people, 'person', 'people'),
      'Search the tree by name.',
      { to: 'people' },
    ),
    guest
      ? tile(
          'play',
          'How are you related?',
          'For family members in the tree',
          'A game about your family.',
          null,
          false,
          'guest',
        )
      : tile('play', 'How are you related?', 'A five-question game', 'A game about your family.', {
          to: 'play',
        }),
    tile(
      'note',
      'Add a memory',
      `Send ${ctx.ownerFirst} a memory or a correction`,
      'A note only the tree’s owner reads.',
      { to: 'note' },
    ),
  ];
  return {
    version: ctx.version,
    mode: ctx.viewer.mode,
    isOwner: ctx.viewer.mode === 'owner',
    hero: {
      hello,
      headline,
      youAre: you,
      stats,
      follows,
      spoken: familySay([hello, headline, you, stats, follows].filter(Boolean).join(' ')),
      open: { to: 'tree' },
    },
    faces,
    reel: reel(ctx, ancestors),
    featured: featured(ctx, ancestors),
    news: news(ctx, since),
    tiles: [
      tile(
        'tree',
        `${familyCapital(voice.poss)} family tree`,
        `${familyCapital(voice.self)} and ${count(maxGen, 'generation', 'generations')} up`,
        'Parents, grandparents and further back.',
        { to: 'tree' },
      ),
      tile(
        'photos',
        'Photos',
        `${count(photoCount(ctx), 'photo', 'photos')}, plus records and graves`,
        'Pictures from the family research.',
        { to: 'gallery', filter: 'photos' },
      ),
      tile(
        'whereWhen',
        'Where and when',
        ctx.placesReady ? 'Through the years, and on a map' : 'Through the years',
        'The family through the decades.',
        { to: 'whereWhen' },
      ),
      familyDnaTile(ctx),
    ],
    more,
    comingSoon: ctx.placesReady ? null : 'The map is coming soon.',
    footnote:
      ctx.viewer.mode === 'owner'
        ? 'Built from your research: records, graves, photos and DNA. Research findings are marked.'
        : `Built from ${ctx.ownerFirst}’s research: records, graves, photos and DNA. Research findings are marked.`,
    owner: ctx.viewer.mode === 'owner' ? ownerExtra : null,
  };
}

/** Home's faces: 5 to 7 photographed ancestors, nearest first (the export's picks when it made
 * them), never anyone on a research path or in a sensitive finding; one large portrait when
 * fewer than 4 have a usable picture. */
function homeFaces(ctx: FamilyPageContext, ancestors: string[]): Record<string, unknown> {
  const settled = ancestors.filter(
    (id) => !ctx.lens.unsettled(id) && !own(ctx.bundle.people, id)?.virtual,
  );
  const allowed = new Set(settled);
  const picked = Array.isArray(ctx.lens.view.faces)
    ? ctx.lens.view.faces.map((face) => face.id).filter((id) => allowed.has(id))
    : [];
  const order = [...picked, ...settled.filter((id) => !picked.includes(id))];
  const photographed: FamilyPersonCard[] = [];
  for (const id of order) {
    if (photographed.length >= 7) break;
    if (!ctx.model.portrait(id)) continue;
    const card = familyPersonCard(ctx.pc, id);
    if (card?.face) photographed.push(card);
  }
  if (photographed.length >= 4) {
    const people = photographed.slice();
    for (const id of settled) {
      if (people.length >= 5) break;
      if (people.some((card) => card.id === id)) continue;
      const card = familyPersonCard(ctx.pc, id);
      if (card) people.push(card);
    }
    return { layout: 'row', people, portrait: null };
  }
  if (photographed.length) {
    const card = photographed[0];
    const mediaId = ctx.model.portrait(card.id) as string;
    const image = familyImage(ctx.pc, mediaId, { prefer: 'restored' });
    const date = own(ctx.bundle.media, mediaId)?.date;
    const caption = `${familyCapital(card.term || card.name)}${card.term ? ` ${card.first}` : ''}${date ? `, ${date}` : ''}`;
    return { layout: 'portrait', people: [card], portrait: image ? { image, caption } : null };
  }
  const people = familyPersonCards(ctx.pc, settled.slice(0, 5));
  return { layout: people.length ? 'row' : 'none', people, portrait: null };
}

/** "About 18 minutes": the export's count when it sent one, else from the words. */
function storyDetail(story: FamilyStory): string {
  if (typeof story.minutes === 'number' && story.minutes > 0)
    return familyListenTime(story.minutes * 1000);
  return familyListenTime((Number(story.words) || 0) * 6);
}

/* ── the tree ─────────────────────────────────────────────────────────── */

const KIND_TEXT: Readonly<Record<string, [string, string, string]>> = {
  step: ['stepfather', 'stepmother', 'step-parent'],
  adopted: ['adoptive father', 'adoptive mother', 'adoptive parent'],
  probable: [
    'probable father, a research finding',
    'probable mother, a research finding',
    'probable parent, a research finding',
  ],
  doubtful: [
    'doubtful father, a research finding',
    'doubtful mother, a research finding',
    'doubtful parent, a research finding',
  ],
  birth: ['father', 'mother', 'parent'],
};

export function familyParentKindText(kind: string, sex: string | null | undefined): string {
  const words = own(KIND_TEXT, kind) || KIND_TEXT.birth;
  return sex === 'M' ? words[0] : sex === 'F' ? words[1] : words[2];
}

/** The v2 parts of /tree: the chart in box units, its summary, legend and the list version. */
export function familyTreeExtras(
  ctx: FamilyPageContext,
  tree: FamilyTree,
): Record<string, unknown> {
  const layout = familyLayoutTree(
    {
      focus: tree.focus,
      nodes: tree.nodes.map((n) => ({ id: n.id, sex: n.sex, lifespan: n.lifespan })),
      links: tree.links,
      couples: tree.couples,
    },
    { up: tree.up, down: tree.down },
  );
  if (!layout) return {};
  const into = new Set(layout.edges.map((edge) => edge.to));
  const boxes = layout.boxes.map((box) => {
    const person = familyPersonCard(ctx.pc, box.id) as FamilyPersonCard;
    const topOfLine = (box.role === 'ancestor' || box.role === 'focus') && !into.has(box.key);
    const above = topOfLine ? ctx.model.depthAbove(box.id) : 0;
    const moreAbove = above > 0 ? above : null;
    return {
      ...box,
      you: box.id === ctx.viewer.personId,
      person,
      moreAbove,
      spoken: familySay(
        `${person.spoken}${moreAbove ? ` ${count(moreAbove, 'more generation', 'more generations')} above.` : ''}`,
      ),
    };
  });
  const distance = (box: FamilyLayoutBox): number =>
    box.role === 'focus'
      ? 0
      : box.role === 'sibling' || box.role === 'spouse'
        ? 0.5
        : Math.abs(box.gen);
  const order = layout.boxes
    .slice()
    .sort(
      (a, b) =>
        distance(a) - distance(b) ||
        (b.gen > 0 ? 1 : 0) - (a.gen > 0 ? 1 : 0) ||
        a.row - b.row ||
        a.x - b.x,
    )
    .map((box) => box.key);
  const shown = new Set(layout.boxes.map((b) => b.id)).size;
  const focusName =
    tree.focus === ctx.lens.anchor ? ctx.lens.voice.self : familyNamed(ctx.pc, tree.focus);
  const summary = `Centred on ${focusName}. ${count(shown, 'person', 'people')} shown.`;
  const sections = new Map<
    string,
    { heading: string; level: number; rank: number; ids: string[] }
  >();
  const addRow = (heading: string, rank: number, id: string): void => {
    const section = sections.get(heading) || { heading, level: 2, rank, ids: [] };
    if (!section.ids.includes(id)) section.ids.push(id);
    sections.set(heading, section);
  };
  for (const box of layout.boxes) {
    if (box.role === 'focus') continue;
    if (box.role === 'sibling') addRow('Brothers and sisters', 100, box.id);
    else if (box.role === 'spouse') addRow('Spouses', 101, box.id);
    else if (box.gen > 0) addRow(familyGenerationName(box.gen), box.gen, box.id);
    else addRow(familyDescendantName(-box.gen), 200 - box.gen, box.id);
  }
  const list = [...sections.values()]
    .sort((a, b) => a.rank - b.rank)
    .map((section) => ({
      heading: section.heading,
      level: section.level,
      rows: section.ids.map((id) => {
        const person = familyPersonCard(ctx.pc, id) as FamilyPersonCard;
        return { id, spoken: person.spoken, person };
      }),
    }));
  return {
    layout: {
      boxes,
      edges: layout.edges,
      couples: layout.couples,
      width: layout.width,
      rows: layout.rows,
      order,
      extraParents: layout.extraParents.map((extra) => ({
        childKey: extra.childKey,
        person: familyPersonCard(ctx.pc, extra.id),
        kindText: familyParentKindText(extra.kind, own(ctx.bundle.people, extra.id)?.sex),
      })),
    },
    summary: { text: summary, spoken: familySay(summary) },
    legend: [
      { key: 'birth', text: 'Solid line: born to' },
      { key: 'step', text: 'Dashed line: step or adoptive parent' },
      { key: 'research', text: 'Dotted line: probable or doubtful parent, a research finding' },
      { key: 'pill', text: 'A magnifying glass marks a research finding, not proven by records' },
      { key: 'side', text: 'Each box says which side of the family it is on' },
    ],
    list,
  };
}

/* ── a person ─────────────────────────────────────────────────────────── */

function factText(fact: FamilyFact): string {
  const place = familyShortPlace(fact.place);
  const at = place ? ` in ${place}` : '';
  const value = String(fact.value || '').trim();
  switch (fact.type) {
    case 'BIRT':
      return `Born${at}`;
    case 'DEAT':
      return `Died${at}`;
    case 'BURI':
      return `Buried${at}`;
    case 'MARR':
      return `Married${at}`;
    case 'DIV':
      return `Divorced${at}`;
    case 'RESI':
      return place ? `Lived in ${place}` : 'A record of where the family lived';
    case 'CENS':
      return `Counted in the census${at}`;
    case 'BAPM':
    case 'CHR':
      return `Baptized${at}`;
    case 'PROB':
      return `Probate${at}`;
    case 'OCCU':
      return value ? `Worked as ${value}` : 'Work';
    case '_MILT':
      return `Military service${value ? `: ${value}` : ''}${at}`;
    case 'IMMI':
      return `Arrived as an immigrant${at}`;
    case 'EMIG':
      return `Left to emigrate${at}`;
    case 'NATU':
      return `Became a citizen${at}`;
    default:
      return `${fact.label || 'An event'}${value ? `: ${value}` : ''}${at}`;
  }
}

function personNutshell(ctx: FamilyPageContext, id: string): string | null {
  const person = own(ctx.bundle.people, id);
  if (!person) return null;
  const born = ctx.model.born(id);
  const died = ctx.model.died(id);
  const birthPlace = familyShortPlace(familyBirthPlace(person));
  const deathPlace = familyShortPlace(
    person.death?.place || (person.facts || []).find((f) => f.type === 'DEAT')?.place,
  );
  const marriage = (person.facts || [])
    .filter((f) => f.type === 'MARR')
    .map((f) => familyDate(f.date))
    .find((d) => d.year != null);
  const marriedAt =
    marriage && born.year != null && !born.approx && !marriage.approx
      ? (marriage.year as number) - born.year
      : null;
  const residences = (person.facts || [])
    .filter((f) => f.type === 'RESI' && f.place && familyDate(f.date).year != null)
    .sort((a, b) => (familyDate(a.date).year as number) - (familyDate(b.date).year as number));
  const last = residences[residences.length - 1];
  const lastPlace = last ? familyShortPlace(last.place) : null;
  const lastYear = last ? (familyDate(last.date).year as number) : null;
  const moved =
    lastPlace &&
    lastYear != null &&
    lastPlace !== birthPlace &&
    (person.living || died.year == null || lastYear <= died.year)
      ? { place: lastPlace, year: lastYear }
      : null;
  return familyNutshell({
    birth: { year: born.year, approx: born.approx, place: birthPlace },
    death: person.living ? null : { year: died.year, approx: died.approx, place: deathPlace },
    living: !!person.living,
    marriedAt,
    children: (person.children || []).filter((c) => own(ctx.bundle.people, c)).length,
    moved,
  });
}

function relationPart(ctx: FamilyPageContext, id: string): Record<string, unknown> | null {
  const lens = ctx.lens;
  const relation = lens.relation(id);
  const person = own(ctx.bundle.people, id);
  if (!relation || !person) return null;
  const steps = lens.steps(id);
  const path = Array.isArray(relation.path)
    ? relation.path.filter((p) => own(ctx.bundle.people, p))
    : [];
  const pathPeople = familyPersonCards(ctx.pc, path.slice(1));
  const pathText =
    path.length > 1
      ? familySay(
          `${lens.voice.selfCapital}, then ${path
            .slice(1)
            .map((p) => familyNamed(ctx.pc, p))
            .join(', then ')}.`,
        )
      : null;
  const pron = familyPronouns(person.sex);
  let dnaLine: string | null = null;
  if (relation.group === 'ancestor' && typeof relation.gen === 'number' && relation.gen > 0) {
    dnaLine = `On average about ${familyShare(relation.gen)} of ${lens.voice.poss} DNA comes from ${pron.object}. From the records, not a DNA test.`;
  } else if (
    relation.group === 'descendant' &&
    typeof relation.gen === 'number' &&
    relation.gen < 0
  ) {
    dnaLine = `On average about ${familyShare(-relation.gen)} of ${pron.poss} DNA comes from ${lens.voice.self}. From the records, not a DNA test.`;
  } else if (relation.group === 'blood' && steps) {
    const up = steps.findIndex((step) => !step.up);
    const k = up === -1 ? steps.length : up;
    const m = steps.length - k;
    if (k > 0 && m > 0 && steps.slice(k).every((s) => !s.up)) {
      const viewerSide = path[k - 1];
      const relativeSide = path[k + 1];
      const full =
        !!viewerSide && !!relativeSide && sameBirthParents(ctx.bundle, viewerSide, relativeSide);
      const coefficient = (full ? 2 : 1) * 0.5 ** (k + m);
      dnaLine = `${lens.voice.borrowed ? `${ctx.ownerFirst} would` : 'You’d'} expect to share ${familyPercent(coefficient)} of ${lens.voice.borrowed ? 'their' : 'your'} DNA, on average.`;
    }
  }
  return {
    term: lens.term(id),
    chain:
      steps && (relation.group === 'ancestor' || relation.group === 'descendant')
        ? familyCardChain(ctx, id)
        : null,
    ladder: steps ? familyLadder(steps, lens.voice) : [],
    pathPeople,
    pathText,
    dnaLine,
    details: null,
  };
}

function familyCardChain(ctx: FamilyPageContext, id: string): string | null {
  return familyPersonCard(ctx.pc, id)?.chain || null;
}

function sameBirthParents(bundle: FamilyBundle, a: string, b: string): boolean {
  const firm = (id: string): string[] =>
    (own(bundle.people, id)?.parents || [])
      .filter((l) => l.kind === 'birth' || l.kind === 'adopted')
      .map((l) => l.id)
      .sort();
  const pa = firm(a);
  const pb = firm(b);
  return pa.length === 2 && pb.length === 2 && pa[0] === pb[0] && pa[1] === pb[1];
}

const MEMBER_TEXT: Readonly<Record<string, Readonly<Record<string, [string, string, string]>>>> = {
  siblings: {
    half: ['half-brother', 'half-sister', 'half-sibling'],
    step: ['stepbrother', 'stepsister', 'step-sibling'],
    doubtful: [
      'doubtful brother, a research finding',
      'doubtful sister, a research finding',
      'doubtful sibling, a research finding',
    ],
  },
  children: {
    step: ['stepson', 'stepdaughter', 'stepchild'],
    adopted: ['adopted son', 'adopted daughter', 'adopted child'],
    probable: [
      'probable son, a research finding',
      'probable daughter, a research finding',
      'probable child, a research finding',
    ],
    doubtful: [
      'doubtful son, a research finding',
      'doubtful daughter, a research finding',
      'doubtful child, a research finding',
    ],
  },
};

function kindText(
  group: string,
  kind: string | undefined,
  sex: string | null | undefined,
): string | null {
  if (!kind || kind === 'birth') return null;
  if (group === 'parents') return familyParentKindText(kind, sex);
  const words = own(MEMBER_TEXT, group) ? own(MEMBER_TEXT[group], kind) : undefined;
  if (!words) return null;
  return sex === 'M' ? words[0] : sex === 'F' ? words[1] : words[2];
}

/** The v2 person page: the v1 answer with the words, pictures and cards added beside it. */
export function familyPersonV2(
  ctx: FamilyPageContext,
  id: string,
  v1: FamilyPersonPayload,
): Record<string, unknown> {
  const person = own(ctx.bundle.people, id);
  if (!person) return { ...v1 };
  const card = familyPersonCard(ctx.pc, id) as FamilyPersonCard;
  const main = person.duplicateOf ? own(ctx.bundle.people, person.duplicateOf) : undefined;
  const surname = String(person.birthSurname || '').trim();
  const bornA =
    surname &&
    !new RegExp(`\\b${surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(
      person.name.trim(),
    )
      ? `born a ${surname}`
      : null;
  const pictureIds = ctx.model.pictures(id);
  const pictures = pictureIds
    .map((mediaId) => familyImage(ctx.pc, mediaId, { prefer: 'restored' }))
    .filter((image): image is FamilyImage => !!image);
  let header: FamilyImage | null = null;
  let headerKind = 'none';
  const portraitId = ctx.model.portrait(id);
  if (portraitId) {
    header = familyImage(ctx.pc, portraitId, { prefer: 'restored' });
    headerKind = header ? 'portrait' : 'none';
  }
  if (!header) {
    const grave = pictures.find((p) => p.category === 'grave');
    if (grave) {
      header = grave;
      headerKind = 'grave';
    }
  }
  if (!header) {
    const scan = v1.records.find(
      (r) =>
        !r.wrong && r.image && ctx.model.isPicture(own(ctx.bundle.media, r.image) as FamilyMedia),
    );
    if (scan && scan.image) {
      header = familyImage(ctx.pc, scan.image, {
        record: { collection: scan.collection, forId: id },
      });
      headerKind = header ? 'record' : 'none';
    }
  }
  const nutshell = personNutshell(ctx, id);
  const life = (person.facts || [])
    .slice()
    .sort((a, b) => (familyDate(a.date).year ?? 99999) - (familyDate(b.date).year ?? 99999))
    .map((fact) => {
      const year = familyDate(fact.date).year;
      const text = factText(fact);
      const records = (fact.records || []).filter((key) => own(ctx.bundle.records, key));
      return {
        year,
        date: fact.date || null,
        text,
        spoken: familySay(`${fact.date || year || 'Undated'}: ${text}.`),
        records,
        sources: records.length ? count(records.length, 'source', 'sources') : null,
      };
    });
  const withCard = <T extends { id: string; kind?: string }>(
    group: string,
    members: T[],
  ): Record<string, unknown>[] =>
    members.map((member) => ({
      ...member,
      ...(familyPersonCard(ctx.pc, member.id) || {}),
      kindText: kindText(group, member.kind, own(ctx.bundle.people, member.id)?.sex),
    }));
  const records = v1.records.map((record) => {
    const scan =
      record.image && !record.wrong
        ? familyImage(ctx.pc, record.image, {
            record: { collection: record.collection, forId: id },
          })
        : null;
    const title = record.collection || 'A record';
    const fields = record.fields || [];
    return {
      ...record,
      fields,
      title,
      scan,
      household: (record.tables || [])[0] || [],
      spoken: familySay(
        `${title}${scan ? ', scan available' : ''}, ${count(fields.length, 'field', 'fields')}${record.wrong ? `. Attached to this person by mistake: ${String(record.wrong).replace(/[.!?\s]+$/, '')}` : ''}.`,
      ),
      wrongText: record.wrong ? `Attached to this person by mistake: ${record.wrong}` : null,
    };
  });
  const memorial = v1.memorials.find((m) => !m.wrong);
  const grave = memorial
    ? {
        id: memorial.id,
        cemetery: memorial.cemetery || null,
        place: memorial.cemetery_place || null,
        dates: [memorial.birth_date, memorial.death_date].filter(Boolean).join(' to ') || null,
        inscription: memorial.inscription || null,
        bio: memorial.bio || null,
        photos: memorial.photos
          .map((photo) => familyImage(ctx.pc, photo.id, { prefer: 'restored' }))
          .filter((image): image is FamilyImage => !!image),
        url: memorial.url && /^https:\/\//i.test(memorial.url) ? memorial.url : null,
      }
    : null;
  const findings = ctx.model.findings
    .filter((f) => f.people.includes(id) && (!f.sensitive || mysteriesAllowed(ctx)))
    .map((f) => {
      const card = familyFindingCard(ctx, f);
      const refs = new Map(v1.findings.flatMap((v) => v.people).map((ref) => [ref.id, ref]));
      return { ...card, people: card.people.map((p) => ({ ...(refs.get(p.id) || {}), ...p })) };
    });
  const sources: Record<string, unknown>[] = [];
  for (const record of v1.records) {
    if (record.wrong) continue;
    sources.push({
      kind: 'record',
      title: record.collection || 'A record',
      citation: record.citation || null,
      url: record.url && /^https:\/\//i.test(record.url) ? record.url : null,
    });
  }
  for (const m of v1.memorials) {
    if (m.wrong) continue;
    sources.push({
      kind: 'memorial',
      title: m.cemetery ? `Find a Grave memorial, ${m.cemetery}` : 'A Find a Grave memorial',
      citation: null,
      url: m.url && /^https:\/\//i.test(m.url) ? m.url : null,
    });
  }
  const withheldCount =
    typeof person.withheld === 'number' && person.withheld > 0 ? person.withheld : 0;
  const born = ctx.model.born(id);
  return {
    ...v1,
    person: {
      ...v1.person,
      ...card,
      otherNames: person.otherNames || [],
      bornA,
      duplicate: main
        ? { text: `This is a second copy of ${main.name} in the tree`, mainId: person.duplicateOf }
        : null,
    },
    header,
    headerKind,
    nutshell: nutshell ? { text: nutshell, spoken: familySay(nutshell) } : null,
    livedThrough: familyLivedThrough(
      born,
      ctx.model.died(id),
      !!person.living,
      new Date(ctx.now).getUTCFullYear(),
    ),
    relation: relationPart(ctx, id),
    pictures: { total: pictures.length, items: pictures.slice(0, 20) },
    life,
    family: {
      parents: withCard('parents', v1.family.parents),
      spouses: withCard('spouses', v1.family.spouses),
      siblings: withCard('siblings', v1.family.siblings),
      children: withCard('children', v1.family.children),
    },
    records,
    grave,
    findings,
    sources,
    withheld: withheldCount
      ? {
          count: withheldCount,
          text:
            withheldCount === 1
              ? '1 source withheld: it names living relatives'
              : `${withheldCount} sources withheld: they name living relatives`,
        }
      : null,
    share: { allowed: true, text: 'From our family history' },
  };
}

/* ── findings ─────────────────────────────────────────────────────────── */

export function familyFindingCard(
  ctx: FamilyPageContext,
  finding: FamilyFindingMeta,
): FamilyFindingCard {
  const proof = familyProof(finding.proof, finding.band);
  const text = finding.text && finding.text !== finding.title ? finding.text : '';
  return {
    key: finding.key,
    title: finding.title,
    text: finding.text,
    summary: finding.summary,
    proof: finding.proof,
    proofText: proof.text,
    proofSpoken: proof.spoken,
    people: familyPersonCards(ctx.pc, finding.people),
    evidence: finding.evidence,
    storySlug: finding.storySlug,
    dna: finding.dna,
    spoken: familySay(
      `${finding.title}${/[.!?]$/.test(finding.title) ? '' : '.'}${text ? ` ${text}` : ''} ${proof.spoken}.`,
    ),
  };
}

/** GET /findings?v=2 and ?group=: discoveries for everyone let in, mysteries per KADE_FH_DNA_FINDINGS. */
export function familyFindingsV2(ctx: FamilyPageContext, group: string): Record<string, unknown> {
  const allowed = mysteriesAllowed(ctx);
  const discoveries = ctx.model.findings
    .filter((f) => !f.sensitive)
    .map((f) => familyFindingCard(ctx, f));
  const mysteries = ctx.model.findings.filter((f) => f.sensitive);
  if (group === 'mysteries') {
    return {
      title: FAMILY_MYSTERIES_TITLE,
      headsUp: FAMILY_MYSTERIES_HEADS_UP,
      available: allowed,
      findings: allowed ? mysteries.map((f) => familyFindingCard(ctx, f)) : [],
    };
  }
  if (group === 'discoveries') return { title: 'Discoveries', findings: discoveries };
  return {
    discoveries,
    mysteries:
      allowed && mysteries.length
        ? {
            title: FAMILY_MYSTERIES_TITLE,
            headsUp: FAMILY_MYSTERIES_HEADS_UP,
            count: mysteries.length,
          }
        : null,
  };
}

/* ── gallery and picture details ──────────────────────────────────────── */

export const FAMILY_GALLERY_KINDS: ReadonlyArray<{
  key: string;
  title: string;
  categories: string[];
}> = [
  { key: 'photos', title: 'Photos', categories: ['portrait', 'photo'] },
  { key: 'portraits', title: 'Portraits', categories: ['portrait'] },
  { key: 'records', title: 'Records', categories: ['record'] },
  { key: 'graves', title: 'Graves', categories: ['grave'] },
  { key: 'documents', title: 'Newspapers and documents', categories: ['document'] },
  { key: 'stories', title: 'Stories and clippings', categories: ['story'] },
  {
    key: 'all',
    title: 'Everything',
    categories: ['portrait', 'photo', 'record', 'grave', 'document', 'story'],
  },
];

export const FAMILY_GALLERY_PAGE: number = 48;

/** GET /gallery. Null for an unknown kind or person. */
export function familyGallery(
  ctx: FamilyPageContext,
  query: { kind: string; person: string; since: string; sort: string; from: number },
): Record<string, unknown> | null {
  const kind = FAMILY_GALLERY_KINDS.find((k) => k.key === (query.kind || 'photos'));
  if (!kind) return null;
  if (query.person && !own(ctx.bundle.people, query.person)) return null;
  const since = new Set<string>();
  if (query.since && Array.isArray(ctx.bundle.changes)) {
    for (const change of ctx.bundle.changes)
      if (change && typeof change.version === 'string' && change.version > query.since)
        for (const id of change.media || []) since.add(id);
  }
  const visible = Object.keys(ctx.bundle.media)
    .map((id) => ctx.bundle.media[id])
    .filter(
      (item) =>
        item.kind !== 'restored' &&
        ctx.model.servable(item) &&
        familyMediaVisible(ctx.bundle, item, ctx.pc.audience) &&
        (!query.person ||
          (item.people || []).includes(query.person) ||
          ctx.model.pictures(query.person).includes(item.id)) &&
        (!query.since || since.has(item.id)),
    );
  const kinds = FAMILY_GALLERY_KINDS.map((k) => ({
    key: k.key,
    title: k.title,
    count: visible.filter((item) => k.categories.includes(ctx.model.category(item))).length,
  }));
  const nearest = (item: FamilyMedia): number =>
    Math.min(
      1000,
      ...(item.people || []).filter((p) => own(ctx.bundle.people, p)).map(ctx.lens.near),
    );
  const yearOf = (item: FamilyMedia): number => familyDate(item.date).year ?? 99999;
  const items = visible
    .filter((item) => kind.categories.includes(ctx.model.category(item)))
    .sort((a, b) =>
      query.sort === 'year'
        ? yearOf(a) - yearOf(b) || nearest(a) - nearest(b) || (a.id < b.id ? -1 : 1)
        : nearest(a) - nearest(b) || yearOf(a) - yearOf(b) || (a.id < b.id ? -1 : 1),
    );
  const total = items.length;
  const from = Math.min(Math.max(0, query.from), Math.max(0, total - 1));
  const page = items.slice(from, from + FAMILY_GALLERY_PAGE).map((item, i) => {
    const record =
      ctx.model.category(item) === 'record' ? recordFor(ctx.bundle, item.id) : undefined;
    const image = familyImage(
      ctx.pc,
      item.id,
      record ? { record: { collection: record.collection } } : {},
    ) as FamilyImage;
    /* added onto the same object, so the signed addresses filled in later land on it */
    return Object.assign(image, {
      caption: familyCaption(item.caption) || image.short,
      people: familyPersonCards(
        ctx.pc,
        (item.people || []).filter((p) => own(ctx.bundle.people, p)),
      ),
      index: from + i + 1,
    });
  });
  return {
    kind: kind.key,
    title: kind.title,
    total,
    from: total ? from : 0,
    count: page.length,
    kinds,
    items: page,
    prev: from > 0 ? Math.max(0, from - FAMILY_GALLERY_PAGE) : null,
    next: from + FAMILY_GALLERY_PAGE < total ? from + FAMILY_GALLERY_PAGE : null,
    pageSpoken: familyPageSpoken(total ? from : 0, page.length, total),
  };
}

const scanRecords = new WeakMap<FamilyBundle, Map<string, string>>();

/** The record a scan belongs to (one lookup table per bundle). */
function recordFor(
  bundle: FamilyBundle,
  mediaId: string,
): { collection?: string; key: string } | undefined {
  let map = scanRecords.get(bundle);
  if (!map) {
    map = new Map();
    for (const key of Object.keys(bundle.records)) {
      const image = bundle.records[key].image;
      if (image && !map.has(image)) map.set(image, key);
    }
    scanRecords.set(bundle, map);
  }
  const key = map.get(mediaId);
  return key ? { collection: bundle.records[key]?.collection, key } : undefined;
}

/** GET /media/:id/info. Null when the viewer may not see it. `fileText` is a story document's
 * words, read by the router from the export's text file. */
export function familyMediaInfo(
  ctx: FamilyPageContext,
  id: string,
  fileText: string | null = null,
): Record<string, unknown> | null {
  const item = own(ctx.bundle.media, id);
  if (!item || !familyMediaVisible(ctx.bundle, item, ctx.pc.audience)) return null;
  const original =
    item.kind === 'restored' && item.restoredFrom
      ? (own(ctx.bundle.media, item.restoredFrom) as FamilyMedia)
      : item;
  const category = ctx.model.category(original);
  const record = category === 'record' ? recordFor(ctx.bundle, original.id) : undefined;
  const image = familyImage(
    ctx.pc,
    id,
    record ? { record: { collection: record.collection } } : {},
  );
  if (!image) return null;
  let source: { kind: string; title: string };
  if (record) source = { kind: 'record', title: record.collection || 'A record' };
  else if (original.kind === 'grave') source = { kind: 'grave', title: 'Find a Grave' };
  else source = { kind: 'tree', title: 'The family tree' };
  const text = image.text || (fileText ? fileText.trim() : null) || null;
  return {
    image,
    caption: familyCaption(original.caption) || image.short,
    description: image.description,
    described: image.described,
    describedNote: image.described ? FAMILY_DESCRIBED_NOTE : null,
    text,
    textAuto: image.textAuto,
    textNote: image.textAuto ? 'Read automatically' : null,
    restoredNotes: item.kind === 'restored' ? item.restoredNotes || null : null,
    people: familyPersonCards(
      ctx.pc,
      (original.people || []).filter((p) => own(ctx.bundle.people, p)),
    ),
    source,
    canAskRestore:
      image.category === 'portrait' || image.category === 'photo' || image.category === 'grave'
        ? !image.restored && image.showing === 'original'
        : false,
  };
}

/* ── stories ──────────────────────────────────────────────────────────── */

function storyResearch(ctx: FamilyPageContext, story: FamilyStory): boolean {
  return story.research === true || ctx.model.findings.some((f) => f.storySlug === story.slug);
}

/** GET /stories?v=2 */
/** May this viewer read this story? A story the export marked sensitive follows the same switch
 * as the family mysteries (KADE_FH_DNA_FINDINGS), and a guest never reads one. */
export function familyStoryAllowed(ctx: FamilyPageContext, story: FamilyStory): boolean {
  return story.sensitive !== true || mysteriesAllowed(ctx);
}

/** GET /stories?v=2: the stories this viewer may read, and clippings from the tree. */
export function familyStoriesV2(ctx: FamilyPageContext): Record<string, unknown> {
  const clippings = Object.keys(ctx.bundle.media)
    .map((id) => ctx.bundle.media[id])
    .filter(
      (item) =>
        item.kind !== 'restored' &&
        ctx.model.servable(item) &&
        ctx.model.category(item) === 'story' &&
        familyMediaVisible(ctx.bundle, item, ctx.pc.audience),
    )
    .map((item) => ({
      id: item.id,
      title: familyCaption(item.caption) || 'A clipping',
      people: familyPersonCards(
        ctx.pc,
        (item.people || []).filter((p) => own(ctx.bundle.people, p)),
      ),
    }));
  return {
    stories: ctx.bundle.stories
      .filter((story) => ctx.readable(story) && familyStoryAllowed(ctx, story))
      .map((story) => ({
        slug: story.slug,
        title: story.title || story.slug,
        words: Number(story.words) || 0,
        detail: storyDetail(story),
        research: storyResearch(ctx, story),
      })),
    clippings,
  };
}

export interface FamilyStoryV2 {
  detail: string;
  research: { banner: string } | null;
  short: string[] | null;
  whoswho: FamilyPersonCard[];
  blocks: FamilyStoryBlock[];
  sources: FamilyStorySource[];
  chunks: { i: number; text: string; cues: FamilyCue[] }[];
  listen: boolean;
}

/** The v2 parts of /story/:slug, beside the v1 markdown. */
export function familyStoryV2(
  ctx: FamilyPageContext,
  story: FamilyStory,
  markdown: string,
): FamilyStoryV2 {
  const { blocks, sources } = familyStoryBlocks(
    markdown,
    familySourceLookup(ctx.bundle.records, ctx.bundle.memorials),
  );
  const chunks = familyStoryParts(blocks);
  return {
    detail: familyListenTime(familyStoryChars(blocks)),
    research: storyResearch(ctx, story) ? { banner: FAMILY_STORY_RESEARCH_BANNER } : null,
    short:
      Array.isArray(story.short) && story.short.length ? story.short.map(String).slice(0, 3) : null,
    whoswho: familyPersonCards(
      ctx.pc,
      (story.people || []).filter((id) => own(ctx.bundle.people, id)),
    ),
    blocks,
    sources,
    chunks,
    listen: ctx.listenReady && chunks.length > 0,
  };
}
