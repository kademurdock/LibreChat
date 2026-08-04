import { memo } from 'react';
import type { CSSProperties } from 'react';

/**
 * Aug 4 2026 — Kade: "some kind of hypnotic bubbles visually to match the
 * bubbling thoughts sound effect when waiting for them to finish thinking."
 *
 * Decorative ONLY. aria-hidden so screen readers never announce it — the
 * bubbling thinking SOUND plus the spoken "Generating reply…" line already
 * carry the non-visual cue. Holds perfectly still under prefers-reduced-motion.
 * Rendered only in the pure-waiting beat, before any answer text or reasoning
 * has begun to stream, so it never fights the streaming text cursor.
 */
function ThinkingBubblesBase() {
  return (
    <div aria-hidden="true" role="presentation" className="kade-thinking-bubbles">
      <style>{`
        .kade-thinking-bubbles { position: relative; height: 22px; width: 64px; margin: 4px 2px 2px; pointer-events: none; }
        .kade-thinking-bubbles .ktb { position: absolute; bottom: 0; border-radius: 9999px; background: currentColor; opacity: 0; filter: blur(0.2px); animation: ktb-rise 2.4s ease-in-out infinite; }
        @keyframes ktb-rise { 0% { transform: translateY(4px) scale(0.6); opacity: 0; } 25% { opacity: 0.32; } 60% { opacity: 0.18; } 100% { transform: translateY(-14px) scale(1); opacity: 0; } }
        @media (prefers-reduced-motion: reduce) { .kade-thinking-bubbles .ktb { animation: none; opacity: 0.22; transform: none; } }
      `}</style>
      {BUBBLES.map((b, i) => (
        <span key={i} className="ktb" style={{ left: `${b.left}px`, width: `${b.size}px`, height: `${b.size}px`, animationDelay: `${b.delay}s`, animationDuration: `${b.dur}s` } as CSSProperties} />
      ))}
    </div>
  );
}

// Hand-tuned so the drift feels organic rather than a marching row.
const BUBBLES = [
  { left: 2, size: 6, delay: 0.0, dur: 2.4 },
  { left: 12, size: 4, delay: 0.5, dur: 2.0 },
  { left: 20, size: 7, delay: 0.9, dur: 2.7 },
  { left: 30, size: 5, delay: 0.2, dur: 2.2 },
  { left: 40, size: 4, delay: 1.1, dur: 2.5 },
  { left: 48, size: 6, delay: 0.7, dur: 2.1 },
  { left: 56, size: 4, delay: 1.4, dur: 2.6 },
];

const ThinkingBubbles = memo(ThinkingBubblesBase);
ThinkingBubbles.displayName = 'ThinkingBubbles';
export default ThinkingBubbles;
