'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * kadeSoundBoothStitch.js — joining the parts back into one recording.
 *
 * The other half of "if files are too long, we need a thing that cuts them off
 * or something auto" (Part 122, Sep 3 2026). kadeSoundBoothSplit.js cuts; this
 * puts the pieces back so she gets ONE file, not homework.
 *
 * ffmpeg is already in this image (Dockerfile line 11, there since the Seed
 * Audio clip trimmer). execFile, never exec — a shell in the middle of a path
 * built from anything user-shaped is how a filename becomes a command.
 *
 * WHY A CONCAT FILE AND NOT `-i a.mp3 -i b.mp3`: the concat DEMUXER joins
 * streams without re-encoding (`-c copy`), so a two-part render sounds exactly
 * like its parts. Her standing rule is as HQ as it can be, and a needless
 * mp3->mp3 round trip is quality spent for nothing. If `-c copy` refuses (parts
 * that disagree on sample rate), it falls back to ONE re-encode and says so in
 * the returned notes rather than failing the render she already paid for.
 * ───────────────────────────────────────────────────────────────────────── */

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const STITCH_TIMEOUT_MS = parseInt(process.env.SOUNDBOOTH_STITCH_TIMEOUT_MS || '120000', 10);

function run(args, timeout = STITCH_TIMEOUT_MS, bin = FFMPEG) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '').slice(-1500);
        return reject(err);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** ffmpeg's concat list format needs single quotes doubled, nothing else. */
function concatLine(file) {
  return `file '${file.replace(/'/g, "'\\''")}'`;
}

/**
 * Join MP3 buffers, in order, into one MP3 buffer.
 * @param {Buffer[]} buffers parts, already downloaded, in playing order
 * @returns {Promise<{buffer: Buffer, reencoded: boolean, notes: string[]}>}
 */
async function stitchMp3Buffers(buffers) {
  const parts = (buffers || []).filter((b) => b && b.length);
  if (!parts.length) throw new Error('nothing to stitch');
  if (parts.length === 1) return { buffer: parts[0], reencoded: false, notes: [] };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-stitch-'));
  const notes = [];
  try {
    const files = [];
    for (let i = 0; i < parts.length; i++) {
      const f = path.join(dir, `part-${String(i).padStart(3, '0')}.mp3`);
      await fs.writeFile(f, parts[i]);
      files.push(f);
    }
    const listFile = path.join(dir, 'parts.txt');
    await fs.writeFile(listFile, files.map(concatLine).join('\n') + '\n');
    const out = path.join(dir, 'joined.mp3');

    const base = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile];
    try {
      await run([...base, '-c', 'copy', out]);
    } catch (e) {
      /* Parts that disagree on sample rate cannot be copied. One re-encode is
       * better than handing back nothing, but SAY it happened. */
      notes.push('the parts had to be re-encoded to join cleanly');
      await run([...base, '-c:a', 'libmp3lame', '-b:a', '192k', out]);
    }
    const buffer = await fs.readFile(out);
    if (!buffer.length) throw new Error('ffmpeg produced an empty file');
    return { buffer, reencoded: notes.length > 0, notes };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ⚠️ SCAR, caught by its own test the night it was written: the first version
 * read ffmpeg's `time=` PROGRESS lines and took the last one. Those lines are
 * printed on a timer, not at the end, so a five-second join measured 3.52 s —
 * and that number is what gets SPOKEN to her ("Ready, three seconds of audio")
 * about a recording she is holding. ffprobe reports the real duration; the
 * decode below is only a fallback for a file with no readable header. */
async function durationOf(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-dur-'));
  try {
    const f = path.join(dir, 'a.mp3');
    await fs.writeFile(f, buffer);
    try {
      const { stdout } = await run(
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f],
        60000,
        FFPROBE,
      );
      const n = parseFloat(String(stdout).trim());
      if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100;
    } catch (_) {
      /* fall through to a full decode */
    }
    const res = await run(['-nostdin', '-hide_banner', '-i', f, '-f', 'null', '-'], 120000).catch((e) => ({
      stderr: e.stderr || '',
    }));
    const m = String(res.stderr).match(/time=(\d+):(\d+):(\d+\.\d+)/g);
    if (!m || !m.length) return null;
    const last = m[m.length - 1].replace('time=', '').split(':');
    return Math.round((Number(last[0]) * 3600 + Number(last[1]) * 60 + Number(last[2])) * 100) / 100;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The join as a sentence, because it is read aloud. */
function sayStitched(partCount, seconds, notes) {
  const m = Math.floor((seconds || 0) / 60);
  const s = Math.round((seconds || 0) % 60);
  const len = m ? `${m} minute${m === 1 ? '' : 's'} ${s} seconds` : `${s} seconds`;
  return `Ready. ${partCount} parts joined into one recording, ${len} of audio.${notes && notes.length ? ` Note: ${notes.join('; ')}.` : ''}`;
}

module.exports = { stitchMp3Buffers, durationOf, sayStitched, concatLine };
