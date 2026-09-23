'use strict';
/* Which app and build a feedback report came from (Part 269, Sep 23 2026).
 *
 * Until now a report from the iPhone app and one from the Android app looked
 * the same on the board: surface 'app', no version, no phone, and the agent
 * hard-coded to 'Report a problem'. The new /feedback page and the coming
 * native "Tell Kade how it's going" screens send these optional fields. Each
 * is checked and cut to size here; anything unknown is dropped, and a body
 * without them behaves exactly as before. */
const PLATFORMS = ['android', 'ios', 'web'];
const ENTRIES = { 'how-its-going': "How it's going" };

function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Pure: request body → the optional fields to store (never throws). */
function feedbackClientFields(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if (PLATFORMS.includes(b.platform)) out.platform = b.platform;
  const appVersion = clean(b.appVersion, 40);
  if (appVersion) out.appVersion = appVersion;
  const device = clean(b.device, 80);
  if (device) out.device = device;
  if (Object.prototype.hasOwnProperty.call(ENTRIES, b.entry)) out.agent = ENTRIES[b.entry];
  return out;
}

module.exports = { feedbackClientFields, PLATFORMS };
