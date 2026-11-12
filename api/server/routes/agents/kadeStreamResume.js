'use strict';
/**
 * KADE Nov 12 2026 (phase 4 pick 4): a reply stream that picks itself back up after a drop.
 *
 * GenerationJobManager (packages/api/src/stream) numbers every event it really sends or holds for
 * the next listener and keeps them in a bounded per-job log (in-memory store only). A client that
 * asks for ids (`kadeSeq=1` on GET /chat/stream/:streamId) gets an `id: <epoch>-<seq>` line on each
 * logged event. After a drop it reconnects with `Last-Event-ID: <epoch>-<seq>` and gets exactly the
 * events after that one, once each and in order, then the live stream, then the final frame.
 *
 * Anything that cannot be served exactly says so in one `kade_gap` event ({ reason }):
 *   - `other-job`: the cursor belongs to a turn that has been replaced; the stream ends there and
 *     the client reloads the saved messages (never hand an old turn's listener the new turn);
 *   - `out-of-range`: trimmed away or past the end; `no-log`: no log for this job (Redis store,
 *     KADE_STREAM_LOG=0, or a job made before the switch). Both then run today's plain subscribe.
 *
 * Switches: KADE_STREAM_LOG=0 (no log, no ids, no cursor branch: exactly the old wire);
 * KADE_STREAM_LOG_MAX (events kept per job, default 8000, read by the manager).
 * A client that does not send kadeSeq=1 (the website and Android today) gets a byte-identical wire.
 * Kept out of index.js so the stream handler changes stay a few lines. No '~' requires.
 */

function kadeStreamLogOn(env = process.env) {
  return String((env && env.KADE_STREAM_LOG) ?? '').trim() !== '0';
}

/** "9f3a1c2e-128" -> { epoch, seq }. Anything else is no cursor. */
function parseKadeCursor(raw) {
  const m = /^([0-9a-f]{8})-(\d{1,9})$/.exec(String(raw || '').trim());
  return m ? { epoch: m[1], seq: parseInt(m[2], 10) } : null;
}

/**
 * Per-request state for one GET /chat/stream/:streamId.
 * @param {{ req: object, manager: object, logger?: object, env?: object }} opts
 */
function createKadeStreamResume({ req, manager, logger, env = process.env }) {
  const query = (req && req.query) || {};
  const wantsSeq =
    query.kadeSeq === '1' &&
    kadeStreamLogOn(env) &&
    !!manager &&
    typeof manager.kadeIdOf === 'function' &&
    typeof manager.kadeReplayAfter === 'function';
  const header =
    req && typeof req.get === 'function'
      ? req.get('Last-Event-ID')
      : req && req.headers && req.headers['last-event-id'];
  const cursor = wantsSeq ? parseKadeCursor(header) : null;
  let seqEpoch = cursor ? cursor.epoch : null;
  let lastSeq = cursor ? cursor.seq : 0;
  let live = true;
  let heldDone = null;

  return {
    wantsSeq,
    cursor,
    /**
     * The `id:` line for this event: '' when it has none (or ids were not asked for),
     * null when this client already has it and it must not be written again.
     */
    idLine(event) {
      if (!wantsSeq) return '';
      const id = manager.kadeIdOf(event);
      if (!id) return '';
      if (id.epoch === seqEpoch && id.seq <= lastSeq) return null;
      seqEpoch = id.epoch;
      lastSeq = id.seq;
      return `id: ${id.epoch}-${id.seq}\n`;
    },
    /** True while a cursor replay is still being written: the final frame must wait for it. */
    holdDone(event) {
      if (live) return false;
      heldDone = event;
      return true;
    },
    /**
     * The cursor branch of the subscribe step. Returns { ended: true } when the response was
     * ended here (other-job), else { result } (the subscription, or null when subscribe failed).
     */
    async subscribe({ streamId, writeEvent, onDone, onError, subscriptionOptions, res }) {
      const first = manager.kadeReplayAfter(streamId, cursor.epoch, cursor.seq);
      if (!first || !first.exact) {
        const reason = first ? first.reason : 'no-log';
        /* The cursor is not trusted past here: a cursor past the end would otherwise hide every
         * live event up to its number (the audit's draft kept it and lost them). */
        seqEpoch = null;
        lastSeq = 0;
        writeEvent({ reason }, { eventName: 'kade_gap' });
        logger?.info?.(`[AgentStream] cursor resume not exact for ${streamId} (${reason})`);
        if (reason === 'other-job') {
          res.end(); // this client was following a turn that has been replaced: do not hand it the new one
          return { ended: true };
        }
        const result = await manager.subscribe(streamId, writeEvent, onDone, onError, subscriptionOptions);
        return { result };
      }
      live = false;
      let result = null;
      try {
        for (const event of first.events) {
          writeEvent(event);
        }
        // While not live, events are dropped here on purpose: every one of them is in the log.
        result = await manager.subscribe(
          streamId,
          (event) => {
            if (live) {
              writeEvent(event);
            }
          },
          onDone,
          onError,
          subscriptionOptions,
        );
        const rest = manager.kadeReplayAfter(streamId, cursor.epoch, lastSeq);
        if (rest && rest.exact) {
          for (const event of rest.events) {
            writeEvent(event);
          }
        }
      } finally {
        live = true; // same synchronous block as the catch-up: nothing can slip between
      }
      logger?.info?.(
        `[AgentStream] cursor resume for ${streamId}: replayed after ${cursor.seq}, now at ${lastSeq}`,
      );
      if (heldDone) {
        const done = heldDone;
        heldDone = null;
        onDone(done);
      }
      return { result };
    },
  };
}

module.exports = { kadeStreamLogOn, parseKadeCursor, createKadeStreamResume };
