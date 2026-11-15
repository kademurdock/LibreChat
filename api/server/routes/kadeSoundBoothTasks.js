'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * kadeSoundBoothTasks.js — Clean up or change a recording, on AuK (Nov 15 2026).
 *
 * AuK follows only its own trained instruction phrases, one task per request (AUK_EDIT_DIAGNOSIS.md,
 * Nov 14). Free-form edit instructions mostly did nothing. So, like Change words
 * (kadeSoundBoothWords.js), these are sent as DATA: a task id and a few fixed choices. The bridge
 * (auk-tasks.js) builds AuK's exact template from them; nothing here is ever an instruction. The one
 * typed field, the new voice's description, only fills the slot inside AuK's timbre template.
 *
 * Each try is a fresh take on a fresh seed (the render route draws it, as for every edit).
 * A long recording is still made in sections and joined (planAukEdit), and every section gets the
 * same task, which suits these whole-recording changes. Keep one speaker is the exception: "first
 * to talk" means something different in each section, so it is held to one short stretch.
 *
 * The task ids and choices here are the bridge's (auk-tasks.js); the tests in both pin the same list.
 * ───────────────────────────────────────────────────────────────────────── */

const MAX_DESCRIPTION = 300;
/* The worker cuts a recording into windows of up to 28 s of input plus output; a stretch of 14 s or
 * less is one window, so "first to talk" means the same speaker from start to end. */
const MAX_SPEAKER_RANGE_S = 14;

const ORDINAL = { 1: 'first', 2: 'second', 3: 'third' };
/* pe.config.yaml emotion_multipliers and nonverbal delete adjustments, as the bridge has them. */
const EMOTION_LENGTH = { sad: 1.22, fearful: 1.16, happy: 1.06, angry: 1.06, surprised: 1.06, disgusted: 1.06, calm: 1.06, excited: 1.06 };
const SOUND_DELTA = { breaths: -0.6, laughs: -1.05, sighs: -1.05, coughs: -1.05, ums: -0.9 };
const EFFECT_NAME = { phone: 'phone', megaphone: 'megaphone', underwater: 'underwater, muffled' };
const SOUND_NAME = { breaths: 'breaths', laughs: 'laughs', sighs: 'sighs', coughs: 'coughs', ums: 'ums and uhs' };

/* Each task: its choices (slot -> allowed values), the plain line her library shows, and how long
 * the result is for `s` seconds in (absent: the same length). */
const TASKS = {
  clean_up: { slots: {}, caption: () => 'Clean up noise and echo.' },
  restore_muffled: { slots: {}, caption: () => 'Restore muffled audio.' },
  remove_effect: { slots: { effect: ['phone', 'megaphone', 'underwater'] }, caption: ({ effect }) => `Remove the ${EFFECT_NAME[effect]} sound.` },
  keep_singing: { slots: {}, caption: () => 'Keep only the singing.' },
  keep_voices: { slots: {}, caption: () => 'Keep all the voices and drop the music.' },
  keep_speaker: { slots: { speaker: [1, 2, 3] }, caption: ({ speaker }) => `Keep only the ${ORDINAL[speaker]} person to talk.` },
  speed: { slots: { speed: [0.5, 0.75, 1.25, 1.5, 2] }, caption: ({ speed }) => `Change the speed to ${speed} times.`, seconds: (s, { speed }) => s / speed },
  pitch: { slots: { direction: ['up', 'down'], semitones: [1, 2, 3] },
    caption: ({ direction, semitones }) => `${direction === 'up' ? 'Raise' : 'Lower'} the pitch by ${semitones} semitone${semitones === 1 ? '' : 's'}.` },
  volume: { slots: { direction: ['up', 'down'], db: [5, 10, 15] },
    caption: ({ direction, db }) => `Make it ${db} decibels ${direction === 'up' ? 'louder' : 'quieter'}.` },
  emotion: { slots: { emotion: ['happy', 'angry', 'sad', 'fearful', 'surprised', 'disgusted', 'calm', 'excited'] },
    caption: ({ emotion }) => `Make it sound ${emotion}.`, seconds: (s, { emotion }) => s * EMOTION_LENGTH[emotion] },
  whisper_to_normal: { slots: {}, caption: () => 'Turn a whisper into a normal voice.' },
  remove_accent: { slots: {}, caption: () => 'Remove the accent.' },
  remove_sound: { slots: { sound: ['breaths', 'laughs', 'sighs', 'coughs', 'ums'] },
    caption: ({ sound }) => `Remove the ${SOUND_NAME[sound]}.`, seconds: (s, { sound }) => Math.max(0.1, s + SOUND_DELTA[sound]) },
  voice: { slots: { description: 'text' }, caption: ({ description }) => `Change the voice to: ${description}.` },
};
const TASK_IDS = Object.keys(TASKS);
const SLOT_WORDS = { effect: 'an effect to remove', speaker: 'the speaker to keep', speed: 'a new speed', direction: 'up or down', semitones: 'how many semitones', db: 'how many decibels', emotion: 'an emotion', sound: 'the sound to remove' };

const num = (value) => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);

/** The typed voice description, one line, no double quotes (the bridge does the same). */
function cleanDescription(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/["“”]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * The task asked for on the page (fix_task and fix_<slot> fields), checked, with the plain line
 * for her library and the length of the result.
 * @param {object} b the render body
 * @param {number} seconds the recording's length
 * @param {{ looksLikeWordChange?: (text: string) => boolean }} [rules]
 * @returns {{ task: string, slots: object, caption: string, genSeconds: number|null }}
 * @throws {Error} with one plain sentence for her.
 */
function planTask(b, seconds, { looksLikeWordChange } = {}) {
  const id = b.fix_task;
  const spec = typeof id === 'string' && Object.prototype.hasOwnProperty.call(TASKS, id) ? TASKS[id] : null;
  if (!spec) throw new Error('Pick what to do with the recording.');
  const slots = {};
  for (const [name, allowed] of Object.entries(spec.slots)) {
    const given = b['fix_' + name];
    if (allowed === 'text') {
      const text = cleanDescription(given);
      if (!text) throw new Error('Describe the new voice first.');
      if (text.length > MAX_DESCRIPTION) throw new Error(`Keep the voice description under ${MAX_DESCRIPTION} characters.`);
      if (looksLikeWordChange && looksLikeWordChange(text)) throw new Error('Describe only the voice. To change words, choose change words under Task.');
      slots[name] = text;
      continue;
    }
    const value = allowed.every((v) => typeof v === 'number') ? num(given) : given;
    if (!allowed.includes(value)) throw new Error(`Choose ${SLOT_WORDS[name]} from the list.`);
    slots[name] = value;
  }
  const start = Number.isFinite(b.edit_start) ? b.edit_start : 0;
  const end = Math.min(Number.isFinite(b.edit_end) ? b.edit_end : seconds, seconds);
  const span = end - start;
  if (id === 'keep_speaker' && span > MAX_SPEAKER_RANGE_S + 0.05) {
    throw new Error(`Keep one speaker works on ${MAX_SPEAKER_RANGE_S} seconds or less at a time. Set Edit from second and Edit to second around that stretch.`);
  }
  const genSeconds = spec.seconds && span > 0 ? Math.round(spec.seconds(span, slots) * 1000) / 1000 : null;
  return { task: id, slots, caption: spec.caption(slots), genSeconds };
}

module.exports = { TASKS, TASK_IDS, planTask, cleanDescription, MAX_DESCRIPTION, MAX_SPEAKER_RANGE_S };
