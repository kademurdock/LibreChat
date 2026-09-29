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

const support = `<section class="support-card" id="support" aria-labelledby="support-title"><p class="eyebrow">Help make the next description possible</p><h2 id="support-title">Free to enjoy.<br>Help keep it going.</h2><p>I’m totally blind. I use AI and other tools to make audio descriptions, and that work costs money. Donations pay for website hosting, platform upkeep, and more described videos.</p><p>Your support also helps keep published recordings free for people on fixed or no incomes. If you enjoy something here and can afford to help, any amount is welcome. If you can’t donate, you’re still welcome.</p><div class="support-actions"><a class="button" href="https://cash.app/$kademurdock">Donate with Cash App — $kademurdock</a><a class="button" href="https://paypal.me/kademurdock">Donate with PayPal — paypal.me/kademurdock</a></div><p class="support-note">Donations are optional. An account is required to play or download published recordings; no donation or family membership is required. For credit on your own AI account, use <a href="/usage-dashboard">Top up in your dashboard</a>.</p><p>Another way to help: share a release’s page with someone who would enjoy it.</p></section>`;

const contact = `<section class="contact-card" id="contact" aria-labelledby="contact-title"><h2 id="contact-title">Get in touch</h2><p>Questions, ideas, or another way you’d like to help? Email me at <a href="mailto:kademurdock@gmail.com">kademurdock@gmail.com</a>.</p><p>Need an account? <a href="/request-access">Request an account</a>. I review requests before approving account access. Already have a code? <a href="/register">Create your account</a>.</p></section>`;

export function publicPage(
  kind: 'home' | 'watch' | 'release' | 'missing' | 'support',
  cards: string[],
  release?: IPublicRelease,
  track?: MediaTrack,
): string {
  const pageTitle =
    kind === 'watch'
      ? 'Watch & Listen — Kade Murdock'
      : 'Kade Murdock — Stories, sound, and shared experiences';
  const sectionTitle = kind === 'support' ? 'Support this work — Kade Murdock' : pageTitle;
  const title = release ? `${release.title} — Kade Murdock` : sectionTitle;
  const description =
    release?.description ||
    'Described videos, sound, and creations by Kade Murdock. Explore the latest releases and find your way into the Kade-AI app.';
  const listing = cards.length
    ? `<div class="releases">${cards.join('')}</div>`
    : `<div class="empty"><p class="eyebrow">A new place for my work</p><h3>The first releases are on their way.</h3><p>This is where you’ll find the videos and recordings I choose to publish. Come back to see what’s new.</p></div>`;
  const mediaTag = track?.mime.startsWith('video/') ? 'video' : 'audio';
  const signIn = release
    ? '/login?redirect_to=' + encodeURIComponent('/watch/' + release._id)
    : '/login';
  const player =
    release && track
      ? `<p class="eyebrow">A release by Kade Murdock</p><h1>${escape(release.title)}</h1><p class="intro">${escape(release.description)}</p><div id="release-access" data-slug="${escape(release._id)}"><p>Free with an account. No family access or donation required.</p><div id="release-signin"><a class="button" href="${escape(signIn)}">Sign in to play or download</a><p>Need an account? <a href="/request-access">Request an account</a>. Kade reviews requests before approving account access.</p></div><div id="release-actions" hidden><button id="release-open" type="button">Open player</button><button id="release-download" type="button">Download recording</button></div><${mediaTag} id="release-player" controls playsinline preload="none" aria-label="${escape(release.title)}" hidden>Your browser cannot play this recording. Use Download recording to save it.</${mediaTag}><p id="player-error" role="status"></p><p id="download-thanks" hidden>Enjoy the recording. If you can, <a href="/support">help fund the next audio description</a>.</p></div><p><a href="/watch">Explore more releases</a></p>`
      : '';
  const content = {
    home: `<section class="hero"><div><p class="eyebrow">Described videos and recordings</p><h1>Press play.<br><em>I’ll describe it.</em></h1><p class="intro">I’m Kade Murdock. This is a home for my described videos, recordings, and the things I make.</p><a class="button" href="/watch">Watch &amp; listen <span aria-hidden="true">↗</span></a><a class="hero-support" href="/support">Help fund more descriptions</a></div><div class="sound-art" aria-hidden="true"><div class="record"><div class="record-label">KADE<br><span>PLAY SOMETHING GOOD</span></div></div><span class="sound-caption">Picture. Sound. Description.</span></div></section><section class="catalog"><div class="section-heading"><div><p class="eyebrow">From my collection of work</p><h2>Watch &amp; listen</h2></div><a href="/watch">All releases <span aria-hidden="true">↗</span></a></div>${listing}</section>${support}<section class="about" id="about"><p class="eyebrow">Audio description</p><h2>The visuals, in words.</h2><p>I’m building a place for described content, sound, and shared experiences. Audio description brings the visual parts of a video into words, alongside its original sound.</p><p>When you hear “more at kademurdock.com,” this is where to find it.</p></section><section class="app-card"><div><p class="eyebrow">Library, calls, and creative tools</p><h2>Step into Kade-AI</h2><p>The app brings the Library, Clubhouse, creative tools, and companions together. Already have an account? Your usual sign-in works here.</p></div><div class="app-actions"><a class="button" href="/home">Open my home</a><a href="/request-access">Request an account</a><a href="https://apps.apple.com/app/id6791024001">Get the iPhone app</a><a href="/Kade-AI.apk" download>Download the Android app (APK)</a><a href="/help/android">Android installation help</a></div></section>`,
    watch: `<section class="page-heading"><p class="eyebrow">Kade Murdock</p><h1>Watch &amp; listen</h1><p class="intro">Browse the recordings I’ve chosen to share. Sign in to play or download them, free. No family membership needed.</p><p>New here? <a href="/request-access">Request an account</a>. Kade reviews requests before approving account access.</p></section>${listing}`,
    release: `<section class="release-page">${player}</section>${support}<script src="/assets/community/public-player.js?v=20260928b" defer></script>`,
    support: `<section class="page-heading"><h1>Support this work</h1><p class="intro">More audio descriptions. A place to find them. Your help keeps both going.</p></section>${support}${contact}`,
    missing: `<section class="page-heading"><h1>This release isn’t available.</h1><p>It may have been taken down or moved.</p><a class="button" href="/watch">Browse releases</a></section>`,
  }[kind];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><meta name="description" content="${escape(description.slice(0, 300))}"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description.slice(0, 300))}"><meta property="og:type" content="website"><link rel="stylesheet" href="/assets/community/public.css?v=20260928b"></head><body>
<a class="skip" href="#main">Skip to content</a><header class="masthead"><a class="wordmark" href="/" aria-label="Kade Murdock, home"><span class="monogram" aria-hidden="true">km.</span><span>Kade Murdock</span></a><nav aria-label="Main"><a href="/watch"${kind === 'watch' ? ' aria-current="page"' : ''}>Watch &amp; listen</a><a href="/#about">About</a><a class="support-nav" href="/support">Donate / Support</a><a class="signin" href="/home">Sign in / My home <span aria-hidden="true">↗</span></a></nav></header>
<main id="main">${content}</main>
<footer><a class="wordmark" href="/">Kade Murdock</a><p>Stories, sound, and shared experiences.</p><nav aria-label="Footer"><a href="/watch">Watch &amp; listen</a><a href="/home">My home</a><a href="/request-access">Request an account</a><a href="/support">Donate / Support</a><a href="mailto:kademurdock@gmail.com">Contact Kade</a><a href="/help/privacy">Privacy</a></nav><small>© ${new Date().getUTCFullYear()} Kade Murdock</small></footer></body></html>`;
}
