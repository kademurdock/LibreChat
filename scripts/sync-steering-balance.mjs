/* Nov 12 2026 (WEB-12): the web client pairs %%% voice tags with the same balancer the server and
 * the voice proxy use. This writes client/src/utils/steeringBalance.js from
 * api/server/utils/steeringBalance.js. Run it after every balancer update:
 *   node scripts/sync-steering-balance.mjs
 * client/src/utils/__tests__/voiceTags.test.ts fails while the two differ. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../api/server/utils/steeringBalance.js', import.meta.url));
const to = fileURLToPath(new URL('../client/src/utils/steeringBalance.js', import.meta.url));
const HEADER =
  '/* eslint-disable */\n// GENERATED from api/server/utils/steeringBalance.js by scripts/sync-steering-balance.mjs. Do not edit.\n';
const src = readFileSync(from, 'utf8').replace(/\r\n/g, '\n');
const out = src
  .replace(/^'use strict';\n/, HEADER)
  .replace(
    "process.env.KADE_STEERING_BALANCE === '0'",
    "globalThis.process?.env?.KADE_STEERING_BALANCE === '0'",
  )
  .replace(/module\.exports = \{([^}]*)\};\s*$/, 'export {$1};\n');
if (
  !out.startsWith(HEADER) ||
  out.includes('module.exports') ||
  out.includes(' process.env') ||
  !/\nexport \{[^}]*\};\n$/.test(out)
) {
  throw new Error('sync-steering-balance: transform incomplete');
}
writeFileSync(to, out);
console.log('wrote', to, out.length, 'chars');
