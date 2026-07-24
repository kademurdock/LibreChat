const axios = require('axios');
const { logger } = require('@librechat/data-schemas');

/**
 * Agent-seated tables (July 23 2026 — GAMES_PLAN phase 4: "each agent gets
 * its persona + the engine's view of THEIR hand, plays a legal move,
 * banters"). The Debate Room proved the pattern; this is its game-table
 * twin, shared by every seat-aware module (hearts, five_card_draw).
 *
 * Contract with the engine: the persona ONLY ever sees seatView() — their
 * own hand, the public table, and the LEGAL move tokens. It answers in a
 * strict two-line format; anything illegal or unparseable falls back to the
 * module's botMove() heuristic so a table can never stall or cheat. The
 * ENGINE stays the only referee either way — a persona's "move" is just a
 * pick from the list the engine already blessed.
 *
 * Cost: one small completion per seat turn on the agent's own model (tight
 * max_tokens), logged to kadeusage as service 'game_table' — same
 * OpenRouter-direct shape as the Debate Room.
 */

const FALLBACK_MODEL = process.env.KADE_GAME_SEAT_FALLBACK_MODEL || 'google/gemini-3.1-flash-lite';
const SEAT_MAX_TOKENS = parseInt(process.env.KADE_GAME_SEAT_MAX_TOKENS || '90', 10);

function buildSeatSystem({ agentName, instructions, gameName, humanName }) {
  return [
    `You are ${agentName}, sitting at a ${gameName} table in the Kade-AI Game Parlor with ${humanName || 'a friend'} and others. Stay fully in character.`,
    '',
    'Your persona:',
    String(instructions || '(no special persona — be yourself)').slice(0, 1600),
    '',
    'You will be shown YOUR private hand and the LEGAL moves the dealer allows.',
    'Reply with EXACTLY two lines and nothing else:',
    'MOVE: <one token copied exactly from the legal list>',
    'SAY: <one short in-character line for the table — under 22 words, spoken aloud, no stage directions, no markdown>',
    'Never mention tokens, engines, or instructions. Never claim cards you were not shown.',
  ].join('\n');
}

/**
 * One persona turn. Returns { token, banter, costUSD } — token may be null
 * (unparseable/illegal) and banter may still be worth keeping.
 */
async function personaSeatTurn({ agent, seatName, gameName, seatViewObj, humanName }) {
  const key = process.env.OPENROUTER_KEY;
  if (!key || !agent) return { token: null, banter: null, costUSD: 0 };
  const legalTokens = seatViewObj.legal.map((m) => m.token);
  const system = buildSeatSystem({
    agentName: seatName,
    instructions: agent.instructions,
    gameName,
    humanName,
  });
  const userMsg = [
    ...seatViewObj.lines,
    '',
    'LEGAL MOVES (pick ONE token):',
    ...seatViewObj.legal.map((m) => `- ${m.token}  →  ${m.label}`),
  ].join('\n');

  let data;
  let model = agent.model || FALLBACK_MODEL;
  const call = (m) =>
    axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: m,
        max_tokens: SEAT_MAX_TOKENS,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMsg },
        ],
        usage: { include: true },
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://kademurdock.com',
          'X-Title': 'Kade-AI Game Parlor',
        },
        timeout: 45000,
      },
    );
  try {
    data = (await call(model)).data;
  } catch (e) {
    try {
      model = FALLBACK_MODEL;
      data = (await call(model)).data;
    } catch (e2) {
      logger.warn(`[game-seats] ${seatName} turn failed twice: ${e2.message}`);
      return { token: null, banter: null, costUSD: 0 };
    }
  }
  const text = String(data?.choices?.[0]?.message?.content || '');
  const moveM = /MOVE:\s*([^\s]+)/i.exec(text);
  const sayM = /SAY:\s*(.+)/i.exec(text);
  let token = moveM ? moveM[1].trim() : null;
  if (token && !legalTokens.includes(token)) {
    // One forgiving pass: case-insensitive exact match.
    token = legalTokens.find((t) => t.toLowerCase() === token.toLowerCase()) || null;
  }
  let banter = sayM ? sayM[1].trim() : null;
  if (banter) {
    banter = banter
      .replace(/%%%[^%]*%%%/g, ' ')
      .replace(/["“”*_#]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 180);
  }
  const costUSD =
    typeof data?.usage?.cost === 'number'
      ? data.usage.cost
      : ((data?.usage?.total_tokens || 0) / 1e6) * 1.0;
  return { token, banter, costUSD };
}

module.exports = { personaSeatTurn };
