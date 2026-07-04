/**
 * Game Parlor visual table (July 3 2026 — Kade's ask: "add a visual element
 * to the games").
 *
 * Renders a live picture of a parlor table — cards, dice, chips, scores,
 * quiz options — from GET /api/kade/game-view/:gameId. The engine's tool
 * result plants an invisible [table:id] token in the agent's reply; Text.tsx
 * mounts this widget for the latest message and ConversationMode shows a
 * compact one during in-app calls.
 *
 * ACCESSIBILITY CONTRACT (Kade's hard rule: visuals must never step on
 * access): everything drawn here is ALREADY said in the agent's message —
 * this widget adds zero information. The whole subtree is aria-hidden and
 * unfocusable, so VoiceOver/NVDA users get the exact same experience they
 * had before it existed. Animations respect prefers-reduced-motion.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { useAuthContext } from '~/hooks';

type CardT = { r?: string; s?: string; back?: boolean };
type Seat = {
  name: string;
  you?: boolean;
  turn?: boolean;
  cards?: CardT[];
  total?: number | null;
  score?: number;
  books?: string[];
};
type GridT = { name: string; cells: string[][] };
type RowT = { label?: string; value: string; strong?: boolean };
type Visual = {
  kind: 'cards' | 'dice' | 'quiz' | 'grid' | 'board';
  seats: Seat[];
  grids?: GridT[];
  rows?: RowT[];
  pile?: CardT | null;
  suit?: string | null;
  pool?: number;
  chips?: number;
  riding?: number;
  target?: number;
  round?: number;
  rounds?: number;
  question?: { q: string; options: string[]; cat: string; diff: string } | null;
  result?: string | null;
  over?: boolean;
  winner?: number | string | null;
};

const SUIT_CHAR: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣', R: '●', Y: '●', G: '●', B: '●' };
const SUIT_NAME: Record<string, string> = {
  S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs',
  R: 'Red', Y: 'Yellow', G: 'Green', B: 'Blue',
};
const SUIT_COLOR: Record<string, string> = { R: '#c2262e', Y: '#b8860b', G: '#2e7d32', B: '#1e5aa8' };
const WIN_RESULTS = new Set(['win', 'blackjack', 'dealer_bust']);

function youWon(v: Visual): boolean {
  if (!v.over) {
    return false;
  }
  if (v.result != null) {
    return WIN_RESULTS.has(v.result);
  }
  if (typeof v.winner === 'number') {
    return v.winner === 0 || v.seats[v.winner]?.you === true;
  }
  return v.winner === 'player';
}

function PlayingCard({ c, i, small }: { c: CardT; i: number; small?: boolean }) {
  const red = c.s === 'H' || c.s === 'D';
  const tint = (c.s != null && SUIT_COLOR[c.s]) || (red ? '#c2262e' : '#1c1c2e');
  return (
    <span
      className={`kgt-card ${small ? 'kgt-sm' : ''} ${c.back ? 'kgt-back' : ''}`}
      style={{ animationDelay: `${Math.min(i * 90, 720)}ms`, color: tint }}
    >
      {!c.back && (
        <>
          <span className="kgt-rank">{c.r}</span>
          <span className="kgt-suitchar">{SUIT_CHAR[c.s ?? ''] ?? ''}</span>
        </>
      )}
    </span>
  );
}

function Die({ shaking }: { shaking: boolean }) {
  return (
    <span className={`kgt-die ${shaking ? 'kgt-shake' : ''}`}>
      <span className="kgt-pip" />
      <span className="kgt-pip" />
      <span className="kgt-pip" />
    </span>
  );
}

const GameTable = memo(function GameTable({
  gameId,
  refreshKey = '',
  compact = false,
}: {
  gameId: string;
  refreshKey?: string | number;
  compact?: boolean;
}) {
  const { token } = useAuthContext();
  const [data, setData] = useState<{ name: string; visual: Visual } | null>(null);
  const [gone, setGone] = useState(false);
  const reducedMotion = useRef(
    typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  ).current;

  useEffect(() => {
    let dead = false;
    // Small delay: the mount can race the tool's state write on the very
    // first streamed tokens; 400ms makes the first paint reliably current.
    const t = setTimeout(() => {
      fetch(`/api/kade/game-view/${encodeURIComponent(gameId)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((j) => {
          if (!dead && j && j.visual) {
            setData({ name: j.name, visual: j.visual });
          }
        })
        .catch(() => {
          if (!dead) {
            setGone(true);
          }
        });
    }, 400);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [gameId, refreshKey, token]);

  if (gone || !data) {
    return null; // fail-soft: no table, no widget, chat unchanged
  }
  const v = data.visual;
  const won = youWon(v);
  const confetti = won && !reducedMotion;

  return (
    <div className={`kgt-root ${compact ? 'kgt-compact' : ''}`} aria-hidden="true" tabIndex={-1}>
      <style>{KGT_CSS}</style>
      <div className="kgt-felt">
        <div className="kgt-title">
          {data.name}
          {v.kind === 'quiz' && v.rounds != null && (
            <span className="kgt-sub">
              {' '}
              — question {v.round} of {v.rounds}
            </span>
          )}
          {v.kind === 'cards' && v.chips != null && <span className="kgt-sub"> — {v.chips} chips on the line</span>}
        </div>

        {v.kind !== 'quiz' &&
          v.seats.map((seat, si) => (
            <div key={si} className={`kgt-seat ${seat.turn ? 'kgt-turn' : ''}`}>
              <span className="kgt-name">
                {seat.name}
                {seat.turn ? ' ◂' : ''}
                {seat.total != null && ` (${seat.total})`}
                {v.kind === 'dice' && seat.score != null && ` — ${seat.score}`}
                {v.kind === 'cards' && seat.score != null && ` — books: ${seat.score}`}
              </span>
              {seat.cards && (
                <span className="kgt-hand">
                  {seat.cards.map((c, i) => (
                    <PlayingCard key={i} c={c} i={i} small={compact || seat.cards!.length > 9} />
                  ))}
                </span>
              )}
              {seat.books && seat.books.length > 0 && (
                <span className="kgt-books">{seat.books.map((b) => `${b}s`).join(' · ')}</span>
              )}
              {v.kind === 'dice' && v.target != null && (
                <span className="kgt-bar">
                  <span
                    className="kgt-fill"
                    style={{ width: `${Math.min(100, ((seat.score ?? 0) / v.target) * 100)}%` }}
                  />
                </span>
              )}
            </div>
          ))}

        {v.kind === 'cards' && (v.pile != null || v.pool != null) && (
          <div className="kgt-center">
            {v.pile != null && (
              <>
                <span className="kgt-label">Pile:</span>
                <PlayingCard c={v.pile} i={0} />
                {v.suit != null && v.suit !== '' && (
                  <span className="kgt-label">calling {SUIT_NAME[v.suit] ?? v.suit}</span>
                )}
              </>
            )}
            {v.pool != null && <span className="kgt-label">Pool: {v.pool} cards</span>}
          </div>
        )}

        {v.kind === 'dice' && !v.over && (
          <div className="kgt-center">
            <Die shaking={!reducedMotion && (v.riding ?? 0) > 0} />
            <span className="kgt-riding">{v.riding ?? 0} riding</span>
          </div>
        )}

        {v.kind === 'quiz' && (
          <>
            <div className="kgt-scores">
              {v.seats.map((s, i) => (
                <span key={i} className="kgt-chipscore">
                  {s.name}: {s.score ?? 0}
                </span>
              ))}
            </div>
            {v.question != null && (
              <div className="kgt-question">
                <div className="kgt-q">{v.question.q}</div>
                <div className="kgt-opts">
                  {v.question.options.map((o, i) => (
                    <span key={i} className="kgt-opt">
                      {String.fromCharCode(65 + i)}. {o}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {v.kind === 'grid' &&
          (v.grids ?? []).map((g, gi) => (
            <div key={gi} className="kgt-gridwrap">
              <span className="kgt-label">{g.name}</span>
              <div
                className="kgt-grid"
                style={{ gridTemplateColumns: `repeat(${g.cells[0]?.length ?? 1}, 1fr)` }}
              >
                {g.cells.flatMap((row, ri) =>
                  row.map((cell, ci) => (
                    <span key={`${ri}-${ci}`} className={`kgt-cell kgt-c-${cell || 'e'}`}>
                      {cell === 'X' || cell === 'K' || cell === 'x' ? '✕' : cell === 'M' ? '•' : cell === 'o' ? '○' : ''}
                    </span>
                  )),
                )}
              </div>
            </div>
          ))}

        {v.kind === 'board' && (
          <div className="kgt-board">
            {(v.rows ?? []).map((r, ri) => (
              <div key={ri} className={`kgt-row ${r.strong ? 'kgt-strong' : ''}`}>
                {r.label ? <span className="kgt-rowlabel">{r.label}</span> : null}
                <span className="kgt-rowval">{r.value}</span>
              </div>
            ))}
          </div>
        )}

        {v.over === true && (
          <div className={`kgt-banner ${won ? 'kgt-won' : ''}`}>{won ? 'You win!' : 'Game over'}</div>
        )}
        {confetti && (
          <div className="kgt-confetti">
            {Array.from({ length: 26 }).map((_, i) => (
              <span
                key={i}
                style={{
                  left: `${(i * 137) % 100}%`,
                  background: ['#f6c945', '#e2574c', '#4caf82', '#5b8def', '#b56ee0'][i % 5],
                  animationDelay: `${(i % 9) * 140}ms`,
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

const KGT_CSS = `
.kgt-root{margin:10px 0 4px;user-select:none;pointer-events:none}
.kgt-felt{position:relative;overflow:hidden;border-radius:14px;padding:12px 14px;
  background:radial-gradient(ellipse at 50% 20%, #2e7d54 0%, #1d5c3c 65%, #164a30 100%);
  border:1px solid rgba(0,0,0,.35);box-shadow:inset 0 0 24px rgba(0,0,0,.35), 0 1px 3px rgba(0,0,0,.25);
  max-width:560px}
.kgt-compact .kgt-felt{padding:8px 10px;max-width:420px}
.kgt-title{color:#f3ead2;font-weight:700;font-size:.92rem;margin-bottom:8px;letter-spacing:.02em}
.kgt-sub{font-weight:400;opacity:.85}
.kgt-seat{margin:6px 0;padding:4px 6px;border-radius:8px}
.kgt-seat.kgt-turn{background:rgba(246,201,69,.12);outline:1px solid rgba(246,201,69,.5)}
.kgt-name{display:block;color:#e8e2cf;font-size:.8rem;margin-bottom:3px}
.kgt-hand{display:flex;flex-wrap:wrap;gap:4px}
.kgt-card{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;
  width:34px;height:48px;border-radius:5px;background:#fdfbf4;border:1px solid #c9c2ae;
  box-shadow:0 1px 2px rgba(0,0,0,.35);font-weight:700;line-height:1}
.kgt-card.kgt-sm{width:26px;height:37px;font-size:.72rem}
.kgt-rank{font-size:.82em}
.kgt-suitchar{font-size:1em;margin-top:1px}
.kgt-card.kgt-back{background:repeating-linear-gradient(45deg,#3b5ea8 0 4px,#31508f 4px 8px);border-color:#27406f}
.kgt-center{display:flex;align-items:center;gap:8px;margin:8px 0 2px}
.kgt-label{color:#d8d2bd;font-size:.75rem}
.kgt-books{color:#f6c945;font-size:.72rem}
.kgt-bar{display:block;height:5px;border-radius:3px;background:rgba(0,0,0,.35);margin-top:3px;max-width:260px}
.kgt-fill{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#f6c945,#e8a13b);transition:width .6s ease}
.kgt-die{position:relative;display:inline-grid;grid-template-columns:1fr 1fr;gap:3px;place-items:center;
  width:34px;height:34px;background:#fdfbf4;border:1px solid #c9c2ae;border-radius:7px;padding:6px;
  box-shadow:0 1px 2px rgba(0,0,0,.35)}
.kgt-pip{width:6px;height:6px;border-radius:50%;background:#1c1c2e}
.kgt-riding{color:#f6c945;font-weight:700;font-size:.85rem}
.kgt-scores{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}
.kgt-chipscore{background:rgba(0,0,0,.3);color:#e8e2cf;font-size:.75rem;padding:2px 8px;border-radius:999px}
.kgt-question .kgt-q{color:#f3ead2;font-size:.85rem;margin-bottom:6px}
.kgt-opts{display:flex;flex-direction:column;gap:4px}
.kgt-opt{background:rgba(253,251,244,.92);color:#1c1c2e;font-size:.78rem;padding:4px 8px;border-radius:6px;max-width:420px}
.kgt-banner{margin-top:8px;text-align:center;color:#e8e2cf;font-weight:700;font-size:.9rem;
  background:rgba(0,0,0,.28);border-radius:8px;padding:4px}
.kgt-banner.kgt-won{color:#f6c945}
@media (prefers-reduced-motion: no-preference){
  .kgt-card{animation:kgt-deal .38s cubic-bezier(.2,.8,.3,1) both}
  @keyframes kgt-deal{from{transform:translateY(-14px) rotate(-6deg);opacity:0}to{transform:none;opacity:1}}
  .kgt-die.kgt-shake{animation:kgt-shake 1.1s ease-in-out infinite}
  @keyframes kgt-shake{0%,100%{transform:rotate(0)}20%{transform:rotate(-9deg)}40%{transform:rotate(7deg)}60%{transform:rotate(-5deg)}80%{transform:rotate(3deg)}}
}
.kgt-gridwrap{margin:8px 0}
.kgt-grid{display:grid;gap:2px;max-width:300px;margin-top:4px}
.kgt-cell{aspect-ratio:1;display:flex;align-items:center;justify-content:center;
  border-radius:3px;background:rgba(255,255,255,.08);color:#f3ead2;font-size:.7rem;font-weight:700;
  min-width:0;min-height:18px}
.kgt-c-S{background:rgba(91,141,239,.55)}
.kgt-c-X{background:rgba(226,87,76,.75)}
.kgt-c-K{background:rgba(122,34,28,.85)}
.kgt-c-M{background:rgba(255,255,255,.16);color:#bdb6a0}
.kgt-c-x{background:rgba(246,201,69,.28);color:#f6c945}
.kgt-c-o{background:rgba(91,141,239,.28);color:#9db9f5}
.kgt-board{margin:6px 0 2px;display:flex;flex-direction:column;gap:4px}
.kgt-row{display:flex;gap:8px;align-items:baseline}
.kgt-rowlabel{color:#d8d2bd;font-size:.72rem;min-width:84px}
.kgt-rowval{color:#f3ead2;font-size:.82rem;letter-spacing:.03em}
.kgt-row.kgt-strong .kgt-rowval{font-weight:700;font-size:.95rem;color:#f6c945}
.kgt-confetti{position:absolute;inset:0;overflow:hidden}
.kgt-confetti span{position:absolute;top:-10px;width:7px;height:11px;border-radius:2px;opacity:.9;
  animation:kgt-fall 1.9s ease-in forwards}
@keyframes kgt-fall{to{transform:translateY(340px) rotate(540deg);opacity:0}}
`;

export default GameTable;
