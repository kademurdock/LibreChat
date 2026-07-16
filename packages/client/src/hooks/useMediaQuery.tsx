import { useEffect, useState } from 'react';

function getInitialMatch(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(query).matches;
}

/**
 * KADE (July 16 2026): `matches` used to always start as `false` ("not a
 * small screen") on the very first render, only correcting itself a tick
 * later once the effect below ran -- a plain SSR-safety habit that doesn't
 * apply here (this client is a pure SPA, never server-rendered). On a cold
 * app launch that first-render flash was real: every consumer of this hook
 * (Header, UnifiedSidebar, Root, and 20 other call sites) briefly rendered
 * its DESKTOP layout even on a phone, then swapped to the correct mobile
 * layout a moment later -- reported as the chat-history/sidebar toggle
 * looking already "pressed"/expanded on launch, with the real history list
 * only showing up after re-opening the sidebar. Computing the real value
 * synchronously via a lazy useState initializer removes the wrong-then-right
 * flash entirely -- every consumer is correct from the first paint.
 */
export default function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => getInitialMatch(query));

  useEffect(() => {
    const media = window.matchMedia(query);
    if (media.matches !== matches) {
      setMatches(media.matches);
    }
    const listener = () => setMatches(media.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [matches, query]);

  return matches;
}
