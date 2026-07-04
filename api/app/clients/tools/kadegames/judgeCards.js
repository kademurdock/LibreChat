const { houseNames } = require('./deck');
/**
 * Judge-card party games (July 4 2026 overnight build — Kade's direct ask:
 * "cards against humanity, apples to apples, all kinds of stuff like that").
 *
 * One core, two games:
 *   CARDS AGAINST REALITY (key cards_against_reality) — the Cards-Against-
 *     Humanity-style game, renamed July 4 2026 on Kade's morning feedback
 *     ("Wild Blanks isn't self-explanatory"). Adults get the MILD+SPICY
 *     pools shuffled together; child accounts and clean:true tables get
 *     MILD only (the tool layer decides — same silent pattern as
 *     kade_joke; the persona never has to mention it).
 *   CRAB APPLES (key crab_apples) — Apples-to-Apples-style: judge flips a
 *     description card, players play the thing that fits (or hilariously
 *     doesn't). Always clean.
 *
 * How a round runs (voice-first, one human + 2-3 AI rivals):
 *   The judge seat rotates every round, starting with an AI so the human
 *   plays cards immediately. When the human PLAYS: they pick from their own
 *   hand, the AI rivals submit, and the AI judge picks a winner on the spot —
 *   one move, full round. When the human JUDGES: rivals' cards come back
 *   anonymized as A/B/C and the human picks; authors are revealed after.
 *   The ENGINE holds decks/hands/score and enforces every pick — the
 *   character at the table only narrates and hams it up (the iron rule).
 */

const decks = require('./partyDecks');

const HAND_SIZE = 6;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function drawFrom(state, pileKey, discardKey) {
  if (state[pileKey].length === 0 && state[discardKey].length > 0) {
    state[pileKey] = shuffle(state[discardKey]);
    state[discardKey] = [];
  }
  return state[pileKey].pop() || null;
}

function refillHands(state) {
  for (let i = 0; i < state.hands.length; i++) {
    while (state.hands[i].length < HAND_SIZE) {
      const c = drawFrom(state, 'responses', 'responseDiscard');
      if (!c) return;
      state.hands[i].push(c);
    }
  }
}

const LETTERS = ['a', 'b', 'c', 'd'];

function makeJudgeGame(config) {
  const { key, name, blurb, kind } = config;

  const promptWord = kind === 'apples' ? 'card' : 'prompt';

  function buildDecks(clean) {
    if (kind === 'apples') {
      return { prompts: decks.APPLES_GREEN.slice(), responses: decks.APPLES_RED.slice() };
    }
    const prompts = clean
      ? decks.BLANK_PROMPTS_MILD.slice()
      : [...decks.BLANK_PROMPTS_MILD, ...decks.BLANK_PROMPTS_SPICY];
    const responses = clean
      ? decks.BLANK_RESPONSES_MILD.slice()
      : [...decks.BLANK_RESPONSES_MILD, ...decks.BLANK_RESPONSES_SPICY];
    return { prompts, responses };
  }

  function startRound(state, log) {
    state.round += 1;
    state.judge = state.round % state.hands.length; // round 1 -> seat 1 (AI judges first, human plays)
    state.prompt = drawFrom(state, 'prompts', 'promptDiscard');
    state.subs = []; // {seat, card} once played
    refillHands(state);
    if (log) {
      log.push(`Round ${state.round} — ${state.names[state.judge]} ${state.judge === 0 ? 'are' : 'is'} the judge.`);
    }
    if (state.judge === 0) {
      // human judges: rivals submit now, anonymized
      for (let i = 1; i < state.hands.length; i++) {
        const idx = Math.floor(Math.random() * state.hands[i].length);
        state.subs.push({ seat: i, card: state.hands[i].splice(idx, 1)[0] });
      }
      state.subs = shuffle(state.subs);
      state.phase = 'judge';
    } else {
      state.phase = 'play';
    }
  }

  function newGame(opts = {}) {
    const rivals = Math.max(2, Math.min(3, Number.isFinite(parseInt(opts.opponents, 10)) ? parseInt(opts.opponents, 10) : 2));
    const target = Math.max(3, Math.min(10, parseInt(opts.rounds, 10) || 5));
    const clean = kind === 'apples' ? true : opts.clean !== false; // tool decides; default clean unless explicitly adult
    const built = buildDecks(clean);
    const names = ['You', ...(opts.names || []).slice(0, rivals)];
    names.push(...houseNames(rivals + 1 - names.length, names));
    while (names.length < rivals + 1) names.push(`Player ${names.length}`);
    const state = {
      g: key,
      clean,
      target,
      names,
      hands: Array.from({ length: rivals + 1 }, () => []),
      scores: new Array(rivals + 1).fill(0),
      prompts: shuffle(built.prompts),
      promptDiscard: [],
      responses: shuffle(built.responses),
      responseDiscard: [],
      round: 0,
      judge: 0,
      phase: 'play',
      subs: [],
      lastRound: null, // {prompt, played:[{name,card}], winnerName, winningCard}
      status: 'active',
      winner: null,
    };
    startRound(state, null);
    return state;
  }

  function promptLine(state) {
    return kind === 'apples'
      ? `The green card is: "${state.prompt}".`
      : `The prompt: "${state.prompt}"`;
  }

  function fillIn(prompt, card) {
    if (kind === 'apples') return `"${card}" for "${prompt}"`;
    return prompt.includes('____') ? `"${prompt.replace(/____/g, card.toUpperCase())}"` : `"${prompt}" + "${card}"`;
  }

  function scoreRound(state, winnerSeat, log, sounds) {
    const sub = state.subs.find((s) => s.seat === winnerSeat);
    state.scores[winnerSeat] += 1;
    state.lastRound = {
      prompt: state.prompt,
      played: state.subs.map((s) => ({ name: state.names[s.seat], card: s.card })),
      winnerName: state.names[winnerSeat],
      winningCard: sub ? sub.card : '',
    };
    log.push(`Point to ${state.names[winnerSeat]} for ${fillIn(state.prompt, sub ? sub.card : '')} — ${state.scores[winnerSeat]} of ${state.target}.`);
    sounds.push(winnerSeat === 0 ? 'correct_ding' : 'card_slap');
    // spent cards to the discards
    for (const s of state.subs) state.responseDiscard.push(s.card);
    state.promptDiscard.push(state.prompt);
    if (state.scores[winnerSeat] >= state.target) {
      state.status = 'over';
      state.winner = winnerSeat;
      sounds.push(winnerSeat === 0 ? 'win_fanfare' : 'lose_trombone');
      return;
    }
    startRound(state, log);
    sounds.push('card_deal');
  }

  function legal(state) {
    if (state.status !== 'active') return [];
    if (state.phase === 'play') {
      return state.hands[0].map((c, i) => ({ token: `play_${i + 1}`, label: `Play: ${c}` }));
    }
    // judging
    return state.subs.map((s, i) => ({
      token: `pick_${LETTERS[i]}`,
      label: `Pick ${LETTERS[i].toUpperCase()}: "${s.card}"`,
    }));
  }

  function move(state, token) {
    if (state.status !== 'active') return { error: 'This game is over. Start a new one to play again.' };
    const log = [];
    const sounds = [];

    if (state.phase === 'play') {
      const m = /^play_(\d+)$/.exec(String(token || ''));
      if (!m) return { error: `Play a card from your hand. Legal: ${legal(state).map((x) => x.token).join(', ')}.` };
      const idx = parseInt(m[1], 10) - 1;
      if (idx < 0 || idx >= state.hands[0].length) return { error: 'You are not holding that card.' };
      const card = state.hands[0].splice(idx, 1)[0];
      state.subs.push({ seat: 0, card });
      log.push(`You played: "${card}".`);
      sounds.push('card_slap');
      // rivals (non-judge) submit
      for (let i = 1; i < state.hands.length; i++) {
        if (i === state.judge) continue;
        const ri = Math.floor(Math.random() * state.hands[i].length);
        state.subs.push({ seat: i, card: state.hands[i].splice(ri, 1)[0] });
        log.push(`${state.names[i]} slides a card in face-down.`);
      }
      state.subs = shuffle(state.subs);
      // the AI judge reveals and picks on the spot — one move, whole round
      sounds.push('drumroll_short');
      log.push(`${state.names[state.judge]} flips them over:`);
      state.subs.forEach((s, i) => log.push(`  ${LETTERS[i].toUpperCase()}: ${fillIn(state.prompt, s.card)}`));
      const winnerSub = state.subs[Math.floor(Math.random() * state.subs.length)];
      log.push(`${state.names[state.judge]} pick${state.judge === 0 ? '' : 's'} ${state.names[winnerSub.seat] === 'You' ? 'YOURS' : `${state.names[winnerSub.seat]}'s`}.`);
      scoreRound(state, winnerSub.seat, log, sounds);
      return { log, sounds };
    }

    // phase 'judge'
    const m = /^pick_([a-d])$/.exec(String(token || '').toLowerCase());
    if (!m) return { error: `You're the judge — pick a card. Legal: ${legal(state).map((x) => x.token).join(', ')}.` };
    const idx = LETTERS.indexOf(m[1]);
    if (idx < 0 || idx >= state.subs.length) return { error: 'No card under that letter this round.' };
    const winnerSub = state.subs[idx];
    log.push(`You crown ${LETTERS[idx].toUpperCase()}: ${fillIn(state.prompt, winnerSub.card)}.`);
    // reveal authors
    state.subs.forEach((s, i) => log.push(`  ${LETTERS[i].toUpperCase()} was ${state.names[s.seat]}.`));
    sounds.push('drumroll_short');
    scoreRound(state, winnerSub.seat, log, sounds);
    return { log, sounds };
  }

  function view(state) {
    const lines = [];
    lines.push(`Score — ${state.names.map((nm, i) => `${nm}: ${state.scores[i]}`).join(', ')}. First to ${state.target}.`);
    const over = state.status === 'over';
    let winner = null;
    const sounds = [];
    if (over) {
      winner = state.winner === 0 ? 'player' : state.names[state.winner];
      lines.push(state.winner === 0 ? 'You take the crown — funniest one at the table!' : `${state.names[state.winner]} takes the game.`);
    } else if (state.phase === 'play') {
      lines.push(`Round ${state.round}: ${state.names[state.judge]} is judging. ${promptLine(state)}`);
      lines.push(`Your hand — read every card to the player with its number:`);
      state.hands[0].forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
      lines.push(kind === 'apples'
        ? 'They pick the thing that best fits the green card (or is funniest).'
        : 'They pick the card that fills the blank funniest.');
    } else {
      lines.push(`Round ${state.round}: YOU are the judge. ${promptLine(state)}`);
      lines.push('The table played (read each aloud, then let the judge decide):');
      state.subs.forEach((s, i) => lines.push(`  ${LETTERS[i].toUpperCase()}: ${fillIn(state.prompt, s.card)}`));
    }
    return { lines, legal: legal(state), sounds, over, winner };
  }

  return {
    meta: {
      key,
      name,
      blurb,
      minPlayers: 3,
      maxPlayers: 4,
      dealSounds: ['card_shuffle', 'card_deal'],
      hasSpice: kind !== 'apples',
      party: true,
    },
    newGame,
    view,
    move,
    legal,
  };
}

const cardsAgainstReality = makeJudgeGame({
  key: 'cards_against_reality',
  name: 'Cards Against Reality',
  blurb: 'Our house spin on the cards-against game — judge flips a prompt, everyone plays their funniest card. 500+ original cards, spicy or clean. First to 5.',
  kind: 'blanks',
});

const crabApples = makeJudgeGame({
  key: 'crab_apples',
  name: 'Crab Apples',
  blurb: 'Judge flips a description card ("Squeaky"), everyone plays the thing that fits best — or worst. Clean, quick, all ages.',
  kind: 'apples',
});

module.exports = { cardsAgainstReality, crabApples, makeJudgeGame };
