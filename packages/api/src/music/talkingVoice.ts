/**
 * Talking voices that sing (Nov 20 2026). Her ask, after the talk test: "let's just do a single talk singing model next to
 * the rvc one." In that test Seed-VC sang a voice heard only SPEAKING far more naturally than an RVC voice trained on the
 * same speech (RVC has never heard such a voice sing), so the voice worker gained engine "seedvc": the lead is re-sung in
 * the voice of a short reference recording, with no training.
 *
 * A talking voice here is a platform (Inworld) voice, chosen by its number ("Voice N"; her own clones have numbers too, and
 * booth text names no person). Its reference is
 * about thirty seconds of that voice reading TALKING_TEXT through the voice proxy, rendered once and kept in the private
 * bucket at voice-refs/inworld/<label>.wav; it is rendered again after REFERENCE_DAYS, so a voice that was pointed at a new
 * clone (Voice 664 was, Nov 19) is picked up within a week. Speech is free to the account; one reference costs her Inworld plan
 * about a cent.
 */

/** What a reference voice reads: plain, varied, unemotional sentences (Seed-VC uses the first 25 seconds). */
export const talkingText: string =
  'So I finally got the garden cleaned up this weekend, and honestly it took way longer than I thought it would. ' +
  'There were weeds in places I did not even know existed. By the time I was done, my hands were sore, but it looks really good now. ' +
  'You know what is funny? Every time I go to the store with a list, I come home with everything except the one thing I needed. ' +
  'Yesterday it was milk. I bought cheese, crackers, three kinds of fruit, and a candle that smells like a beach, but no milk.';

export const REFERENCE_DAYS: number = 7;
const MAX_VOICE_NUMBER = 5000;

export type TalkingHooks = {
  /** When the object was last written, or null when it is not in the bucket. */
  head: (key: string) => Promise<Date | null>;
  put: (key: string, body: Buffer, contentType: string) => Promise<void>;
  /** The voice proxy's speech for this label, as WAV bytes. */
  speak: (label: string, text: string) => Promise<Buffer>;
};

/** A platform voice number ("801", 801 or "Voice 801") -> "Voice 801"; anything else -> undefined. */
export function talkingLabel(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  const text = String(value).trim().replace(/^voice\s+/i, '');
  if (!/^\d{1,4}$/.test(text)) throw new Error('Type a platform voice number, like 801 for Voice 801.');
  const n = Number(text);
  if (n < 1 || n > MAX_VOICE_NUMBER) throw new Error('Type a platform voice number, like 801 for Voice 801.');
  return `Voice ${n}`;
}

export function talkingKey(label: string): string {
  return `voice-refs/inworld/${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.wav`;
}

/** The reference recording's bucket key, rendered first when it is missing or older than REFERENCE_DAYS. */
export async function talkingReference(label: string, hooks: TalkingHooks, now: number = Date.now()): Promise<string> {
  const key = talkingKey(label);
  const written = await hooks.head(key).catch(() => null);
  if (written && now - written.getTime() < REFERENCE_DAYS * 86400000) return key;
  let audio: Buffer;
  try {
    audio = await hooks.speak(label, talkingText);
  } catch {
    throw new Error(`${label} could not speak its sample, so it cannot sing. Check the voice number, or try again.`);
  }
  if (audio.length < 100000 || audio.subarray(0, 4).toString('latin1') !== 'RIFF')
    throw new Error(`${label} did not give a usable speech sample, so it cannot sing. Choose another voice.`);
  await hooks.put(key, audio, 'audio/wav');
  return key;
}
