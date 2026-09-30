import type { FamilyDnaCluster, FamilyDnaConclusion, FamilyPerson } from './history';
import type { FamilyPersonCard } from './present';
import { familyNamed, familyPersonCard, familyPersonCards, familySay } from './present';
import type { FamilyPageContext } from './pages';
import {
  familyDnaTile,
  familyFollows,
  familyFollowsText,
  familyIsFullSibling,
  familyMysteriesAllowed,
  siblingParentage,
} from './pages';
import { familyBirthPlace, familyRegion } from './derive';
import {
  FAMILY_BIRTHPLACES_NOTE,
  FAMILY_DNA_FOOTNOTE,
  FAMILY_MYSTERIES_HEADS_UP,
  FAMILY_PAPER_NOTE,
  familyCapital,
  familyGenerationName,
  familyList,
  familyPercent,
  familyProof,
  familyPronouns,
  familyShare,
  familyYearText,
} from './words';
import { familyFirstName, own } from './util';

/* ----------------------------------------------------------------------------
 * FAMILY HISTORY DNA (docs/FAMILY_HISTORY.md, "GET /dna")
 *
 * One answer for the DNA screen. `test` is what the owner's DNA test found, said
 * for the signed-in viewer only: all of it for the owner and her full brothers
 * and sisters (the same ancestors exactly), the cards on the shared side for a
 * half-sibling, and for anyone else in the tree only the families they descend
 * from; guests and people married in get none. Family mysteries (sensitive
 * conclusions) follow KADE_FH_DNA_FINDINGS and always sit behind a heads-up.
 * `paper`, `birthplaces` and `abroad` are inheritance on paper, for the viewer
 * or (with ?for=) their spouse or one of their children; `for` never changes
 * `test`. The family sees the research as the owner does (her decision): a
 * cluster's matches, names and shared cM, come through to "Details for DNA
 * fans" whenever the export sends them.
 * THE REPOSITORY IS PUBLIC: no family data belongs here.
 * -------------------------------------------------------------------------- */

export type FamilyDnaApplies = 'self' | 'fullSibling' | 'halfSibling' | 'sharedLine';

export const FAMILY_PAPER_GENERATIONS: number = 7;

/** Theoretical shares on paper; the cM ranges wait for a checked copy of the published table. */
export const FAMILY_DNA_AVERAGES: ReadonlyArray<{
  key: string;
  words: string;
  coefficient: number;
}> = [
  { key: 'parent', words: 'a parent or child', coefficient: 0.5 },
  { key: 'fullSibling', words: 'a full brother or sister', coefficient: 0.5 },
  { key: 'grandparent', words: 'a grandparent or grandchild', coefficient: 0.25 },
  { key: 'halfSibling', words: 'a half brother or half sister', coefficient: 0.25 },
  { key: 'auntUncle', words: 'an aunt, uncle, niece or nephew', coefficient: 0.25 },
  { key: 'greatGrandparent', words: 'a great-grandparent', coefficient: 0.125 },
  { key: 'firstCousin', words: 'a first cousin', coefficient: 0.125 },
  { key: 'firstCousinOnceRemoved', words: 'a first cousin once removed', coefficient: 0.0625 },
  { key: 'secondCousin', words: 'a second cousin', coefficient: 0.03125 },
  { key: 'thirdCousin', words: 'a third cousin', coefficient: 0.0078125 },
];

interface Slot {
  ahnen: number;
  gen: number;
  id: string | null;
  side: 'father' | 'mother';
}

/** The pedigree of one person by ahnentafel number (1 is the person, 2n the father of n, 2n+1 the
 * mother), up to `gens` generations; a person reached twice (cousins who married) fills both slots. */
export function familyPedigree(
  parentsOf: (id: string) => { father: string | null; mother: string | null },
  start: string,
  gens: number,
): Slot[] {
  const out: Slot[] = [];
  let row: (string | null)[] = [start];
  for (let gen = 1; gen <= gens; gen++) {
    const next: (string | null)[] = [];
    for (const id of row) {
      const parents = id ? parentsOf(id) : { father: null, mother: null };
      next.push(parents.father, parents.mother);
    }
    const first = 2 ** gen;
    next.forEach((id, i) => {
      out.push({ ahnen: first + i, gen, id, side: i < next.length / 2 ? 'father' : 'mother' });
    });
    row = next;
  }
  return out;
}

/** "grandparents", "great-grandparents", "3rd great-grandparents". */
function genWords(gen: number): string {
  return familyGenerationName(gen).toLowerCase();
}

/** Whose inheritance "your" is: the viewer's own place in the tree (even when their words are
 * read from the owner's view), or the owner's for a guest. */
export function familyDnaSelf(ctx: FamilyPageContext): string {
  return ctx.viewer.mode === 'guest' ? ctx.lens.anchor : ctx.viewer.personId;
}

function whoseWords(ctx: FamilyPageContext, forId: string): { poss: string; capital: string } {
  if (forId === familyDnaSelf(ctx)) {
    const perspectiveOnly =
      ctx.viewer.mode === 'guest' ||
      (ctx.viewer.mode === 'owner' && ctx.lens.voice.borrowed);
    const poss = perspectiveOnly ? ctx.lens.voice.poss : 'your';
    return { poss, capital: familyCapital(poss) };
  }
  const first = familyFirstName(own(ctx.bundle.people, forId)?.name);
  return { poss: `${first}’s`, capital: `${first}’s` };
}

/** Which cards of the owner's test apply to this viewer, or null. */
export function familyDnaApplies(ctx: FamilyPageContext): FamilyDnaApplies | 'none' {
  const bundle = ctx.bundle;
  const me = ctx.viewer.personId;
  if (ctx.viewer.mode === 'owner') return ctx.lens.voice.borrowed ? 'none' : 'self';
  if (ctx.viewer.mode === 'guest') return 'none';
  if (familyIsFullSibling(bundle, me)) return 'fullSibling';
  const tested = (bundle.dna?.tested || [bundle.owner]).filter((id) => own(bundle.people, id));
  if (tested.length !== 1 || tested[0] !== bundle.owner)
    return sharesLine(ctx) ? 'sharedLine' : 'none';
  const side = String(bundle.dna?.testSide || 'both');
  const ownerParents = ctx.model.parents(bundle.owner);
  const mine = ctx.model.parents(me);
  const shared: string[] = [];
  if (mine.father && mine.father === ownerParents.father) shared.push('father');
  if (mine.mother && mine.mother === ownerParents.mother) shared.push('mother');
  if (
    shared.length === 1 &&
    siblingParentage(bundle, me, bundle.owner) === 'half' &&
    (side === 'both' || shared[0] === side)
  )
    return 'halfSibling';
  return sharesLine(ctx) ? 'sharedLine' : 'none';
}

function sharesLine(ctx: FamilyPageContext): boolean {
  const line = ctx.model.line(ctx.viewer.personId);
  return (ctx.bundle.dna?.clusters || []).some((c) => (c.couple || []).some((id) => line.has(id)));
}

function clusterTitle(ctx: FamilyPageContext, cluster: FamilyDnaCluster): string {
  const couple = (cluster.couple || []).filter((id) => own(ctx.bundle.people, id));
  const gens = couple.map((id) => (ctx.lens.isAncestor(id) ? ctx.lens.relation(id)?.gen : null));
  const names = couple.map((id) => own(ctx.bundle.people, id)?.name || '');
  if (couple.length === 2 && gens[0] && gens[0] === gens[1])
    return `The family of ${ctx.lens.voice.poss} ${genWords(gens[0] as number)} ${familyList(names)}`;
  const related = couple.filter((id) => ctx.lens.term(id));
  if (related.length)
    return `The family of ${familyList(related.map((id) => familyNamed(ctx.pc, id).replace(/, /, ' ')))}`;
  return cluster.title || 'A family in the tree';
}

function card(
  ctx: FamilyPageContext,
  key: string,
  title: string,
  text: string,
  people: FamilyPersonCard[],
  proofLevel: string | undefined,
  band: string | undefined,
  storySlug: string | null,
): Record<string, unknown> {
  const level = proofLevel === 'records' || proofLevel === 'guess' ? proofLevel : 'dna';
  const proof = familyProof(level, band);
  return {
    key,
    title,
    text,
    people,
    proof: level,
    proofText: proof.text,
    storySlug,
    spoken: familySay(`${title}. ${text} ${proof.spoken}.`),
  };
}

function testSection(ctx: FamilyPageContext): Record<string, unknown> | null {
  const dna = ctx.bundle.dna;
  const applies = familyDnaApplies(ctx);
  if (!dna || applies === 'none') return null;
  const owner = ctx.ownerFirst;
  const ownerPron = familyPronouns(own(ctx.bundle.people, ctx.bundle.owner)?.sex);
  const line = ctx.model.line(ctx.viewer.personId);
  const mine = (ids: string[]): boolean => ids.some((id) => line.has(id));
  const all = applies === 'self' || applies === 'fullSibling';
  const whose = applies === 'self' ? 'your' : `${owner}’s`;
  const cards: Record<string, unknown>[] = [];
  for (const cluster of dna.clusters || []) {
    const couple = (cluster.couple || []).filter((id) => own(ctx.bundle.people, id));
    if (!all && !mine(couple)) continue;
    const n = typeof cluster.members === 'number' ? cluster.members : 0;
    const text = n
      ? `${n} of ${whose} DNA cousins descend from this family.`
      : `Some of ${whose} DNA cousins descend from this family.`;
    cards.push({
      ...card(
        ctx,
        cluster.key,
        clusterTitle(ctx, cluster),
        text,
        familyPersonCards(ctx.pc, couple),
        cluster.proof,
        undefined,
        null,
      ),
      band: cluster.band || null,
      members: n || null,
      matches: Array.isArray(cluster.matches) ? cluster.matches : [],
    });
  }
  const conclusion = (c: FamilyDnaConclusion): Record<string, unknown> =>
    card(
      ctx,
      c.key,
      c.title,
      c.text,
      familyPersonCards(
        ctx.pc,
        (c.people || []).filter((id) => own(ctx.bundle.people, id)),
      ),
      c.proof,
      c.band,
      c.storySlug || null,
    );
  for (const c of dna.conclusions || [])
    if (c.sensitive === false && (all || mine(c.people || []))) cards.push(conclusion(c));
  const hidden = (dna.conclusions || []).filter(
    (c) => c.sensitive !== false && (all || mine(c.people || [])),
  );
  const mysteries =
    hidden.length && familyMysteriesAllowed(ctx.viewer.mode, ctx.dnaFindings)
      ? { headsUp: FAMILY_MYSTERIES_HEADS_UP, cards: hidden.map(conclusion) }
      : null;
  let intro: string;
  let title: string;
  if (applies === 'self') {
    title = 'What your DNA test found';
    intro = 'Your DNA test found these families. Each card says how sure the research is.';
  } else if (applies === 'fullSibling') {
    title = `${owner}’s DNA test counts for you too`;
    intro = `You and ${owner} have the same mother and father, so you have exactly the same ancestors. What ${ownerPron.poss} DNA test found about the family is true for you too. You each inherited different pieces, but they point to the same families.`;
  } else if (applies === 'halfSibling') {
    const side = String(ctx.bundle.dna?.testSide || '');
    title = `What ${owner}’s DNA test found about your family`;
    intro = `You and ${owner} share your ${side === 'father' ? 'father' : 'mother'}, so what ${ownerPron.poss} DNA test found on that side of the family is true for you too.`;
  } else {
    title = `What ${owner}’s DNA test found about your family`;
    intro = `${owner}’s DNA test found families you descend from. These cards are only about your own ancestors.`;
  }
  const rows = [...(dna.details?.rows || [])];
  const clusters: Record<string, unknown>[] = [];
  for (const cluster of dna.clusters || []) {
    if (!all && !mine(cluster.couple || [])) continue;
    if (cluster.band) rows.push(`${clusterTitle(ctx, cluster)}: ${cluster.band}.`);
    clusters.push({
      key: cluster.key,
      title: clusterTitle(ctx, cluster),
      band: cluster.band || null,
      members: typeof cluster.members === 'number' ? cluster.members : null,
      matches: Array.isArray(cluster.matches) ? cluster.matches : [],
    });
  }
  return {
    applies,
    title,
    intro,
    cards,
    mysteries,
    details: {
      title: 'Details for DNA fans',
      rows,
      caveats: dna.details?.caveats || [],
      clusters,
    },
    footnote: applies === 'fullSibling' ? FAMILY_DNA_FOOTNOTE : null,
  };
}

/** The wedges of one generation, and the words for it. */
function paperGeneration(
  ctx: FamilyPageContext,
  forId: string,
  gen: number,
  slots: Slot[],
  follows: 'father' | 'mother' | null,
): Record<string, unknown> {
  const whose = whoseWords(ctx, forId);
  const shown = follows ? slots.filter((s) => s.side === follows) : slots;
  const named = shown.filter((s) => s.id).length;
  const total = shown.length;
  const name = genWords(gen);
  const on = follows ? ` on the ${follows}’s side` : '';
  let text: string;
  if (total === 1) {
    const one = follows === 'mother' ? 'mother' : 'father';
    text = named
      ? `${whose.capital} ${one} has a name.`
      : `${whose.capital} ${one} is not known yet.`;
  } else if (named === total) text = `All ${total} of ${whose.poss} ${name}${on} have a name.`;
  else if (named === 0) text = `None of ${whose.poss} ${total} ${name}${on} has a name yet.`;
  else text = `${named} of ${whose.poss} ${total} ${name}${on} have a name.`;
  const wedges = shown.map((slot) => {
    const person = slot.id ? familyPersonCard(ctx.pc, slot.id) : null;
    const research =
      !!slot.id && (!!ctx.lens.research(slot.id) || !!own(ctx.bundle.people, slot.id)?.virtual);
    return {
      ahnen: slot.ahnen,
      state: !slot.id ? 'unknown' : research ? 'research' : 'known',
      side: slot.side,
      living: !!person?.living,
      person,
      share: familyShare(gen),
    };
  });
  return {
    gen,
    name,
    slots: total,
    named,
    text,
    spoken: familySay(`Generation ${gen}, ${name}: ${named} of ${total} known`),
    wedges,
  };
}

function birthplacesFor(
  ctx: FamilyPageContext,
  forId: string,
  pedigree: Slot[],
): Record<string, unknown> | null {
  const whose = whoseWords(ctx, forId);
  const byGen: Record<string, unknown>[] = [];
  for (let gen = 2; gen <= FAMILY_PAPER_GENERATIONS; gen++) {
    const slots = pedigree.filter((s) => s.gen === gen);
    const rows = new Map<
      string,
      { place: string; kind: string; count: number; people: string[] }
    >();
    let known = 0;
    for (const slot of slots) {
      if (!slot.id) continue;
      const region = familyRegion(familyBirthPlace(own(ctx.bundle.people, slot.id)));
      if (!region) continue;
      known++;
      const row = rows.get(region.name) || {
        place: region.name,
        kind: region.abroad ? 'country' : 'state',
        count: 0,
        people: [],
      };
      row.count++;
      if (!row.people.includes(slot.id)) row.people.push(slot.id);
      rows.set(region.name, row);
    }
    if (!known) continue;
    const sorted = [...rows.values()].sort(
      (a, b) => b.count - a.count || a.place.localeCompare(b.place),
    );
    const title = `Where ${whose.poss} ${slots.length} ${genWords(gen)} were born`;
    const unknown = slots.length - known;
    const listed = sorted.map((row) => `${row.count} in ${row.place}`);
    const text = `${familyList(listed)}${unknown ? `. ${unknown} not known yet` : ''}.`;
    byGen.push({
      gen,
      title,
      rows: sorted,
      unknown,
      text,
      spoken: familySay(`${title}: ${text}`),
    });
  }
  if (!byGen.length) return null;
  const pick =
    [...byGen]
      .reverse()
      .find((entry) => (entry.gen as number) <= 6 && (entry.rows as unknown[]).length) || byGen[0];
  return { ...pick, note: FAMILY_BIRTHPLACES_NOTE, byGen };
}

function abroadFor(ctx: FamilyPageContext, forId: string): Record<string, unknown> {
  const whose = whoseWords(ctx, forId);
  const ancestors = [...ctx.model.line(forId)].filter((id) => id !== forId);
  const rows: { person: FamilyPersonCard; text: string; gen: number; year: number }[] = [];
  for (const id of ancestors) {
    const person: FamilyPerson | undefined = own(ctx.bundle.people, id);
    const region = familyRegion(familyBirthPlace(person));
    if (!region?.abroad) continue;
    const card = familyPersonCard(ctx.pc, id);
    if (!card) continue;
    const born = familyYearText(ctx.model.born(id));
    rows.push({
      person: card,
      text: `Born in ${region.name}${born ? ` ${born.startsWith('about') ? born : `in ${born}`}` : ''}.`,
      gen: ctx.lens.relation(id)?.gen || 99,
      year: ctx.model.born(id).year || 9999,
    });
  }
  rows.sort((a, b) => a.gen - b.gen || a.year - b.year || a.person.id.localeCompare(b.person.id));
  const n = rows.length;
  const text = n
    ? `${n} of ${whose.poss} ancestors ${n === 1 ? 'was' : 'were'} born outside the United States.`
    : `None of ${whose.poss} ancestors in the tree was born outside the United States.`;
  return {
    text,
    spoken: familySay(text),
    rows: rows.map((row) => ({ person: row.person, text: row.text })),
  };
}

/** Whose paper ?for= may ask for: the viewer, a spouse, a child. */
export function familyDnaForAllowed(ctx: FamilyPageContext, forId: string): boolean {
  const self = familyDnaSelf(ctx);
  if (forId === self) return true;
  const me = own(ctx.bundle.people, self);
  return !!me && ((me.spouses || []).includes(forId) || (me.children || []).includes(forId));
}

/** GET /dna. `forId` has been checked with familyDnaForAllowed. */
export function familyDnaPayload(ctx: FamilyPageContext, forId: string): Record<string, unknown> {
  const tile = familyDnaTile(ctx);
  const follows =
    (forId === ctx.lens.anchor && !ctx.lens.voice.borrowed ? ctx.lens.view.follows : null) ||
    familyFollows(ctx.model, forId);
  const pedigree = familyPedigree(ctx.model.parents, forId, FAMILY_PAPER_GENERATIONS);
  const generations: Record<string, unknown>[] = [];
  for (let gen = 1; gen <= FAMILY_PAPER_GENERATIONS; gen++) {
    generations.push(
      paperGeneration(
        ctx,
        forId,
        gen,
        pedigree.filter((s) => s.gen === gen),
        follows,
      ),
    );
  }
  const whose = whoseWords(ctx, forId);
  return {
    title: tile.title,
    for: forId,
    forName: forId === familyDnaSelf(ctx) ? null : own(ctx.bundle.people, forId)?.name || null,
    follows: familyFollowsText(follows, ctx.lens.voice),
    test: testSection(ctx),
    paper: {
      title: `Where ${whose.poss} DNA comes from, on paper`,
      startGen: 2,
      half: !!follows,
      note: FAMILY_PAPER_NOTE,
      generations,
    },
    birthplaces: birthplacesFor(ctx, forId, pedigree),
    abroad: abroadFor(ctx, forId),
    compare: {
      title: 'How much DNA you share with a relative',
      averages: FAMILY_DNA_AVERAGES.map((row) => ({
        key: row.key,
        class: row.words,
        percent: familyPercent(row.coefficient),
        text: `With ${row.words}: ${familyPercent(row.coefficient)} on average.`,
        details: null,
      })),
      note: 'On paper, on average. Real shares vary, more so for distant cousins.',
    },
  };
}
