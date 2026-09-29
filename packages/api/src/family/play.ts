import type { FamilyMedia } from './history';
import type { FamilyImage, FamilyPersonCard } from './present';
import { familyImage, familyPersonCard, familySay } from './present';
import type { FamilyPageContext } from './pages';
import { familyHeroImage, familyShortPlace } from './pages';
import { familyBirthPlace } from './derive';
import { familyCapital, familyPronouns, familySideText } from './words';
import { familyDate, familyMediaVisible, familyRandom, familyShuffle, own } from './util';

/* ----------------------------------------------------------------------------
 * FAMILY HISTORY GAME (docs/FAMILY_HISTORY.md, "GET /play")
 *
 * "How are you related?": a few rounds of mixed kinds, each with its answer and
 * the words that explain it. A quiz states its answer as fact, so nobody on a
 * research path, in a sensitive finding or entered only from research is ever
 * asked about. Rounds are drawn from a seed, so one game can be replayed.
 * THE REPOSITORY IS PUBLIC: no family data belongs here.
 * -------------------------------------------------------------------------- */

export type FamilyRoundKind = 'relation' | 'side' | 'older' | 'year' | 'birthplace';

export interface FamilyRound {
  kind: FamilyRoundKind;
  prompt: string;
  spoken: string;
  people: FamilyPersonCard[];
  image: FamilyImage | null;
  choices: { text: string; spoken: string }[];
  answer: number;
  explain: string;
  spokenExplain: string;
  right: string;
  wrong: string;
}

const KINDS: readonly FamilyRoundKind[] = ['relation', 'side', 'older', 'year', 'birthplace'];

/** Generic terms that fill the choices of a small tree, by sex. */
const FILLERS: Readonly<Record<string, string[]>> = {
  F: [
    'mother',
    'grandmother',
    'great-grandmother',
    '2nd great-grandmother',
    'aunt',
    'sister',
    'cousin',
    'niece',
  ],
  M: [
    'father',
    'grandfather',
    'great-grandfather',
    '2nd great-grandfather',
    'uncle',
    'brother',
    'cousin',
    'nephew',
  ],
  U: ['parent', 'grandparent', 'great-grandparent', 'aunt or uncle', 'cousin', 'sibling'],
};

function choiceList(texts: string[]): { text: string; spoken: string }[] {
  return texts.map((text) => ({ text, spoken: familySay(text) }));
}

function explainWords(explain: string): { right: string; wrong: string } {
  return { right: `Right. ${explain}`, wrong: `Not quite. ${explain}` };
}

/** GET /play: `count` rounds (1 to 10) from `seed`. */
export function familyPlayPayload(
  ctx: FamilyPageContext,
  count: number,
  seed: number,
): { seed: number; rounds: FamilyRound[]; score: string } {
  const random = familyRandom(seed);
  const lens = ctx.lens;
  const pool = familyShuffle(
    Object.keys(lens.view.relations).filter((id) => {
      const person = own(ctx.bundle.people, id);
      const relation = lens.relation(id);
      return (
        !!person &&
        !person.duplicateOf &&
        !person.virtual &&
        !!relation &&
        relation.group !== 'self' &&
        !lens.unsettled(id)
      );
    }),
    random,
  );
  const used = new Set<string>();
  const take = (ok: (id: string) => boolean): string | null => {
    const id = pool.find((p) => !used.has(p) && ok(p));
    if (id) used.add(id);
    return id || null;
  };
  const card = (id: string): FamilyPersonCard => familyPersonCard(ctx.pc, id) as FamilyPersonCard;
  const pron = (id: string) => familyPronouns(own(ctx.bundle.people, id)?.sex);

  const relationRound = (): FamilyRound | null => {
    const id = take((p) => !!lens.term(p) && lens.relation(p)?.group !== 'marriage');
    if (!id) return null;
    const answer = lens.term(id) as string;
    const gen = lens.relation(id)?.gen;
    const others = familyShuffle(
      [
        ...new Set(
          pool
            .filter((p) => p !== id && lens.relation(p)?.gen !== gen)
            .map((p) => lens.term(p))
            .filter((t): t is string => !!t && t !== answer && t !== lens.voice.self),
        ),
      ],
      random,
    );
    const sex = String(own(ctx.bundle.people, id)?.sex || 'U');
    const fillers = (FILLERS[sex] || FILLERS.U)
      .map((word) => `${lens.voice.poss} ${word}`)
      .filter((t) => t !== answer && !others.includes(t));
    const distractors = [...others, ...familyShuffle(fillers, random)].slice(0, 3);
    const texts = familyShuffle([answer, ...distractors], random);
    const name = own(ctx.bundle.people, id)?.name || '';
    const chain = card(id).chain;
    const explain = `${familyCapital(pron(id).subject)} ${pron(id).subject === 'they' ? 'are' : 'is'} ${answer}${chain ? `: ${chain}` : ''}.`;
    const prompt = `Who is ${name} to ${lens.voice.self}?`;
    return {
      kind: 'relation',
      prompt,
      spoken: familySay(prompt),
      people: [card(id)],
      image: familyHeroImage(ctx, id),
      choices: choiceList(texts),
      answer: texts.indexOf(answer),
      explain,
      spokenExplain: familySay(explain),
      ...explainWords(explain),
    };
  };

  const sideRound = (): FamilyRound | null => {
    const id = take((p) => {
      const side = lens.side(p);
      return side === 'father' || side === 'mother';
    });
    if (!id) return null;
    const mom = familySideText('mother', lens.voice) as string;
    const dad = familySideText('father', lens.voice) as string;
    const texts = [mom, dad];
    const right = lens.side(id) === 'mother' ? mom : dad;
    const name = own(ctx.bundle.people, id)?.name || '';
    const prompt = `Is ${name} on ${lens.voice.poss} mom’s side or ${lens.voice.poss} dad’s side?`;
    const explain = `${name} is ${lens.term(id) || 'in the family'}, on ${right.charAt(0).toLowerCase()}${right.slice(1)}.`;
    return {
      kind: 'side',
      prompt,
      spoken: familySay(prompt),
      people: [card(id)],
      image: familyHeroImage(ctx, id),
      choices: choiceList(texts),
      answer: texts.indexOf(right),
      explain,
      spokenExplain: familySay(explain),
      ...explainWords(explain),
    };
  };

  const olderRound = (): FamilyRound | null => {
    const dated = (p: string): boolean => {
      const born = ctx.model.born(p);
      return born.year != null && !born.approx;
    };
    const a = take(dated);
    if (!a) return null;
    const yearA = ctx.model.born(a).year as number;
    const b = take((p) => dated(p) && ctx.model.born(p).year !== yearA);
    if (!b) {
      used.delete(a);
      return null;
    }
    const yearB = ctx.model.born(b).year as number;
    const pair = familyShuffle([a, b], random);
    const texts = pair.map((p) => {
      const c = card(p);
      return c.term && c.term !== lens.voice.self ? `${c.name}, ${c.term}` : c.name;
    });
    const older = yearA < yearB ? a : b;
    const nameOf = (p: string): string => own(ctx.bundle.people, p)?.name || '';
    const explain = `${nameOf(a)} was born in ${yearA}, ${nameOf(b)} in ${yearB}.`;
    return {
      kind: 'older',
      prompt: 'Who was born first?',
      spoken: 'Who was born first?',
      people: pair.map(card),
      image: null,
      choices: choiceList(texts),
      answer: pair.indexOf(older),
      explain,
      spokenExplain: familySay(explain),
      ...explainWords(explain),
    };
  };

  const yearRound = (): FamilyRound | null => {
    const candidates: FamilyMedia[] = familyShuffle(
      Object.keys(ctx.bundle.media)
        .map((id) => ctx.bundle.media[id])
        .filter((item) => {
          if (
            item.kind === 'restored' ||
            !ctx.model.servable(item) ||
            !familyMediaVisible(ctx.bundle, item, ctx.pc.audience)
          )
            return false;
          const category = ctx.model.category(item);
          const date = familyDate(item.date);
          return (
            (category === 'portrait' || category === 'photo') &&
            date.year != null &&
            (item.people || []).some((p) => pool.includes(p)) &&
            !(item.people || []).some((p) => lens.unsettled(p))
          );
        }),
      random,
    );
    const item = candidates.find((m) => !used.has(`media:${m.id}`));
    if (!item) return null;
    used.add(`media:${item.id}`);
    const image = familyImage(ctx.pc, item.id, { prefer: 'restored' });
    if (!image) return null;
    const decade = Math.floor((familyDate(item.date).year as number) / 10) * 10;
    const offsets = familyShuffle([-30, -20, -10, 10, 20, 30], random).slice(0, 3);
    const decades = familyShuffle([decade, ...offsets.map((o) => decade + o)], random);
    const texts = decades.map((d) => `The ${d}s`);
    const explain = `This picture is from ${item.date}.`;
    /* the picture's label must not give the answer away */
    const hide = (text: string): string => text.replace(/,[^,.]*\d{4}[^,.]*\./, '.');
    return {
      kind: 'year',
      prompt: 'Guess this picture’s decade.',
      spoken: familySay(`Guess this picture’s decade. ${hide(image.alt)}`),
      people: (item.people || []).filter((p) => own(ctx.bundle.people, p)).map(card),
      /* changed in place, so the signed addresses filled in later land on it */
      image: Object.assign(image, {
        alt: hide(image.alt),
        date: null,
        year: null,
        description: null,
        text: null,
      }),
      choices: choiceList(texts),
      answer: decades.indexOf(decade),
      explain,
      spokenExplain: familySay(explain),
      ...explainWords(explain),
    };
  };

  const birthplaceRound = (): FamilyRound | null => {
    const placeOf = (p: string): string | null =>
      familyShortPlace(familyBirthPlace(own(ctx.bundle.people, p)));
    const id = take((p) => !!placeOf(p));
    if (!id) return null;
    const answer = placeOf(id) as string;
    const others = familyShuffle(
      [...new Set(pool.map(placeOf).filter((p): p is string => !!p && p !== answer))],
      random,
    ).slice(0, 3);
    if (others.length < 1) {
      used.delete(id);
      return null;
    }
    const texts = familyShuffle([answer, ...others], random);
    const name = own(ctx.bundle.people, id)?.name || '';
    const explain = `${name} was born in ${answer}.`;
    const prompt = `Where was ${name} born?`;
    return {
      kind: 'birthplace',
      prompt,
      spoken: familySay(prompt),
      people: [card(id)],
      image: familyHeroImage(ctx, id),
      choices: choiceList(texts),
      answer: texts.indexOf(answer),
      explain,
      spokenExplain: familySay(explain),
      ...explainWords(explain),
    };
  };

  const makers: Record<FamilyRoundKind, () => FamilyRound | null> = {
    relation: relationRound,
    side: sideRound,
    older: olderRound,
    year: yearRound,
    birthplace: birthplaceRound,
  };
  const rounds: FamilyRound[] = [];
  const order = familyShuffle(KINDS, random);
  let misses = 0;
  for (let i = 0; rounds.length < count && misses < KINDS.length * 2; i++) {
    const round = makers[order[i % order.length]]();
    if (round && round.answer >= 0 && round.choices.length >= 2) {
      rounds.push(round);
      misses = 0;
    } else misses++;
  }
  return { seed, rounds, score: `0 of ${rounds.length}` };
}
