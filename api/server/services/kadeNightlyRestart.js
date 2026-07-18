/**
 * Nightly restart (July 18 2026, Kade's go) -- the LibreChat process hoards
 * memory as it runs (avg footprint climbs between deploys and resets on every
 * restart; the app is ~85% of the Chat project's RAM bill). Rather than chase
 * every cache, exit the process once a night at an off-peak hour and let
 * Railway's restart policy bring it straight back (same image, no rebuild --
 * downtime is the container boot, well under a minute).
 *
 * Self-contained on this server by Kade's standing rule (no external
 * scheduler, no Claude dependency). Same shape as the consolidation sweep:
 * a wall-clock check + no fire-at-boot (a deploy landing inside the target
 * hour must not bounce itself again -- the sinceBoot guard covers it).
 *
 * Env:
 *   KADE_NIGHTLY_RESTART=0      -- disable entirely
 *   KADE_NIGHTLY_RESTART_HOUR   -- UTC hour to restart (default 10 = 5am CDT; NOT 9, which would stomp the Sunday 09:00 UTC consolidation sweep mid-pass)
 */
const { logger } = require('@librechat/data-schemas');

function startKadeNightlyRestart() {
  if (process.env.KADE_NIGHTLY_RESTART === '0') {
    logger.info('[kadeNightlyRestart] Disabled by KADE_NIGHTLY_RESTART=0');
    return null;
  }
  const targetHour = parseInt(process.env.KADE_NIGHTLY_RESTART_HOUR || '10', 10);
  const bootedAt = Date.now();
  const interval = setInterval(() => {
    try {
      /* Never restart within 2h of boot -- covers deploys landing in the
       * target hour AND guarantees no restart loop even if the policy
       * revives us inside the same hour. */
      if (Date.now() - bootedAt < 2 * 60 * 60 * 1000) {
        return;
      }
      if (new Date().getUTCHours() !== targetHour) {
        return;
      }
      logger.info(
        '[kadeNightlyRestart] Nightly window reached -- exiting for a clean restart (memory hygiene). Railway restart policy revives this container.',
      );
      /* Give the log a moment to flush, then exit non-zero so Railway's
       * ON_FAILURE restart policy brings the container back up. */
      setTimeout(() => process.exit(1), 1500);
    } catch (e) {
      logger.error('[kadeNightlyRestart] tick error:', e);
    }
  }, 10 * 60 * 1000);
  interval.unref();
  logger.info(
    `[kadeNightlyRestart] Scheduler started -- daily process restart at UTC hour ${targetHour} (>=2h after boot).`,
  );
  return interval;
}

module.exports = { startKadeNightlyRestart };
