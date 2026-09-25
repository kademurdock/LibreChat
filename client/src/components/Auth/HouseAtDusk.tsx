import { useEffect, useRef, useState } from 'react';

/**
 * KADE (Sep 25 2026, the animation-and-pictures plan, "Do these first" item 4):
 * the house on the hill (Picture 85, house-at-dusk.png) on the sign-in and
 * registration pages. Static: no motion, no sound, no live region, no focus
 * stop, nothing focusable inside.
 *
 * - Computers: the painting fills the page behind the solid sign-in card,
 *   cropped to keep the chimney and its smoke. It stops 3rem above the footer
 *   so it never paints over the theme button in the bottom-left corner (that
 *   button stands 72 px above the page bottom; the empty footer is 32 px).
 * - Phones: a short band above the card.
 * - Screen readers: one image with real alt text, in its own place (Kade,
 *   Sep 25 2026: no separate block of picture words at the end of the page;
 *   the words belong on the picture). AuthLayout puts it after the sign-in
 *   card inside main, so it is read after the form's last control and never
 *   before the email box; only CSS moves it up into the band or behind the
 *   card.
 * - Steps aside (and is never downloaded where the browser allows) under
 *   forced colours, Increase Contrast, data saving (the prefers-reduced-data
 *   query, plus navigator.connection.saveData in script), print, narrow or
 *   zoomed screens (under 360 px, 400 % zoom), landscape phones, and very
 *   large text (a browser default text size above 20 px, checked in script).
 *   Where it steps aside it is display: none or not rendered, so it is silent
 *   there too. The breakpoints are in em, so a bigger default text size moves
 *   them too.
 * - No inverted-colors rule: WebKit may match it under iOS Smart Invert, which
 *   would turn the painting into a negative.
 * - Space is reserved before it loads (an absolute layer on computers, a
 *   fixed aspect ratio on phones), so the form never moves. A failed load
 *   keeps that space and shows a plain dusk gradient instead; the broken img
 *   itself gets the hidden attribute (display: none), so its alt text is never
 *   read for a picture that is not there.
 */

/** Kade's alt text for house-at-dusk (Sep 25 2026), true to both crops. */
export const HOUSE_AT_DUSK_ALT =
  'A two-story wood and stone lake house at dusk among pine trees, its windows lit warm with a different room glowing in each.';

/** A 1x1 transparent GIF: the chosen source whenever the painting is hidden, so nothing downloads. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Lowercase on purpose: React 18 warns on the camelCase fetchPriority prop. */
const LOW_FETCH_PRIORITY = { fetchpriority: 'low' } as const;

const HIDE_QUERY =
  '(forced-colors: active), (prefers-contrast: more), (prefers-reduced-data: reduce), print';
/** 1024 x 576 at the default text size. */
const DESK_QUERY = '(min-width: 64em) and (min-height: 36em)';
/** 360 x 480 at the default text size; shorter screens (landscape phones) stay plain. */
const BAND_QUERY = '(min-width: 22.5em) and (min-height: 30em)';

/** A browser default text size above this many pixels counts as very large text. */
const LARGE_TEXT_PX = 20;

const HOUSE_CSS = `
.kade-house {
  display: none;
  background: linear-gradient(180deg, #1f2a4d 0%, #4b3a67 40%, #c9725a 66%, #2a2f4a 100%);
}
.kade-house picture,
.kade-house img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 68% 40%;
}
.kade-house img[hidden] { display: none; }
@media ${BAND_QUERY} {
  .kade-house {
    display: block;
    order: -1;
    width: 100%;
    max-width: 370px;
    aspect-ratio: 12 / 5;
    max-height: 25vh;
    margin: 0 0 0.75rem;
    border-radius: 0.5rem;
    overflow: hidden;
    pointer-events: none;
    user-select: none;
  }
}
@media ${DESK_QUERY} {
  .kade-house {
    position: absolute;
    inset: 1rem 1rem 3rem;
    width: auto;
    max-width: none;
    aspect-ratio: auto;
    max-height: none;
    margin: 0;
    border-radius: 1rem;
  }
  .kade-house img { object-position: 68% 5%; }
  .kade-auth-card { z-index: 1; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35); }
}
@media ${HIDE_QUERY} {
  .kade-house { display: none !important; }
}
`;

/**
 * The two reasons CSS cannot see on its own: Data Saver (Chrome and Android
 * expose it only as navigator.connection.saveData) and a very large browser
 * text size (the root font size, which page zoom does not change).
 */
export function houseShouldStepAside(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return true;
  }
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection != null && connection.saveData === true) {
    return true;
  }
  const rootPx = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
  return rootPx > LARGE_TEXT_PX;
}

export function HouseAtDuskPicture() {
  /* Checked before the first render, so the painting is never requested; the
   * effect checks once more after mount in case the root text size settles late. */
  const [stepAside] = useState(houseShouldStepAside);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current != null && houseShouldStepAside()) {
      box.current.style.display = 'none';
    }
  }, []);

  if (stepAside) {
    return null;
  }
  return (
    <>
      <style>{HOUSE_CSS}</style>
      <div ref={box} className="kade-house">
        <picture>
          <source media={HIDE_QUERY} srcSet={BLANK} />
          <source
            media={DESK_QUERY}
            srcSet="/assets/art/house-at-dusk-1440.webp"
            type="image/webp"
          />
          <source
            media={BAND_QUERY}
            srcSet="/assets/art/house-at-dusk-768.webp"
            type="image/webp"
          />
          <img
            src={BLANK}
            alt={HOUSE_AT_DUSK_ALT}
            hidden={failed}
            width={768}
            height={320}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
            {...LOW_FETCH_PRIORITY}
          />
        </picture>
      </div>
    </>
  );
}
