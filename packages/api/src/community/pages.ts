import type { IPublicRelease } from '@librechat/data-schemas';
import type { MediaTrack } from './contracts';

const escape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function releaseCard(release: IPublicRelease): string {
  return `<article class="release"><span class="eyebrow">Watch &amp; listen</span><h3><a href="/watch/${escape(release._id)}">${escape(release.title)}</a></h3><p>${escape(release.description.slice(0, 240))}</p><a class="text-link" href="/watch/${escape(release._id)}">Open ${escape(release.title)} <span aria-hidden="true">↗</span></a></article>`;
}

export function publicPage(
  kind: 'home' | 'watch' | 'release' | 'missing',
  cards: string[],
  release?: IPublicRelease,
  track?: MediaTrack,
): string {
  const title = release
    ? `${release.title} — Kade Murdock`
    : kind === 'watch'
      ? 'Watch & Listen — Kade Murdock'
      : 'Kade Murdock — Stories, sound, and shared experiences';
  const description =
    release?.description ||
    'Described videos, sound, and creations by Kade Murdock. Explore the latest releases and find your way into the Kade-AI app.';
  const listing = cards.length
    ? `<div class="releases">${cards.join('')}</div>`
    : `<div class="empty"><p class="eyebrow">A new place for my work</p><h3>The first releases are on their way.</h3><p>This is where you’ll find the videos and recordings I choose to publish. Come back to see what’s new.</p></div>`;
  const player =
    release && track
      ? `<p class="eyebrow">A release by Kade Murdock</p><h1>${escape(release.title)}</h1><p class="intro">${escape(release.description)}</p><${track.mime.startsWith('video/') ? 'video' : 'audio'} controls playsinline preload="metadata" aria-label="${escape(release.title)}" src="/api/community/releases/${escape(release._id)}/stream">Your browser cannot play this recording. <a href="/api/community/releases/${escape(release._id)}/stream">Open the media file</a>.</${track.mime.startsWith('video/') ? 'video' : 'audio'}><p><a href="/watch">Explore more releases</a></p>`
      : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><meta name="description" content="${escape(description.slice(0, 300))}"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description.slice(0, 300))}"><meta property="og:type" content="website"><link rel="stylesheet" href="/assets/community/public.css"></head><body>
<a class="skip" href="#main">Skip to content</a><header class="masthead"><a class="wordmark" href="/" aria-label="Kade Murdock, home"><span class="monogram" aria-hidden="true">km.</span><span>Kade Murdock</span></a><nav aria-label="Main"><a href="/watch"${kind === 'watch' ? ' aria-current="page"' : ''}>Watch &amp; listen</a><a href="/#about">About</a><a class="signin" href="/home">Sign in / My home <span aria-hidden="true">↗</span></a></nav></header>
<main id="main">${kind === 'home' ? `<section class="hero"><div><p class="eyebrow">Described videos and recordings</p><h1>Press play.<br><em>I’ll describe it.</em></h1><p class="intro">I’m Kade Murdock. This is a home for my described videos, recordings, and the things I make.</p><a class="button" href="/watch">Watch &amp; listen <span aria-hidden="true">↗</span></a></div><div class="sound-art" aria-hidden="true"><div class="record"><div class="record-label">KADE<br><span>PLAY SOMETHING GOOD</span></div></div><span class="sound-caption">Picture. Sound. Description.</span></div></section><section class="catalog"><div class="section-heading"><div><p class="eyebrow">From my collection of work</p><h2>Watch &amp; listen</h2></div><a href="/watch">All releases <span aria-hidden="true">↗</span></a></div>${listing}</section><section class="about" id="about"><p class="eyebrow">Audio description</p><h2>The visuals, in words.</h2><p>I’m building a place for described content, sound, and shared experiences. Audio description brings the visual parts of a video into words, alongside its original sound.</p><p>When you hear “more at kademurdock.com,” this is where to find it.</p></section><section class="app-card"><div><p class="eyebrow">Library, calls, and creative tools</p><h2>Step into Kade-AI</h2><p>The app brings the Library, Clubhouse, creative tools, and companions together. Already have an account? Your usual sign-in works here.</p></div><div class="app-actions"><a class="button" href="/home">Open my home</a><a href="https://apps.apple.com/app/id6791024001">Get the iPhone app</a><a href="/Kade-AI.apk" download>Download the Android app (APK)</a><a href="/help/android">Android installation help</a></div></section>` : kind === 'watch' ? `<section class="page-heading"><p class="eyebrow">Kade Murdock</p><h1>Watch &amp; listen</h1><p class="intro">Videos, recordings, and creations I’ve chosen to share. No account needed.</p></section>${listing}` : kind === 'release' ? `<section class="release-page">${player}<p id="player-error" role="status"></p></section><script src="/assets/community/public-player.js" defer></script>` : `<section class="page-heading"><h1>This release isn’t available.</h1><p>It may have been taken down or moved.</p><a class="button" href="/watch">Browse releases</a></section>`}</main>
<footer><a class="wordmark" href="/">Kade Murdock</a><p>Stories, sound, and shared experiences.</p><nav aria-label="Footer"><a href="/watch">Watch &amp; listen</a><a href="/home">My home</a><a href="/help/privacy">Privacy</a></nav><small>© ${new Date().getUTCFullYear()} Kade Murdock</small></footer></body></html>`;
}
