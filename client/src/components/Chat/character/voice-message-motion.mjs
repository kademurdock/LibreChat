export function voiceMessagePose({ id, time, level = 0, active }) {
  const still = { characterId: id, active: false, mouth: 0, blink: 0, brow: 0, tilt: 0, nod: 0 };
  if (!active || !Number.isFinite(time) || time < 0) return still;
  let seed = 5381;
  for (const byte of new TextEncoder().encode(id || 'unknown'))
    seed = (Math.imul(seed, 33) + byte) >>> 0;
  const phase = (seed % 1000) / 1000;
  const period = 4.3 + phase * 0.8;
  const t = time + phase * period,
    blinkPhase = t % period;
  const secondBlink =
    Math.floor(t / period) % 3 === 1 && blinkPhase > period - 0.52 && blinkPhase < period - 0.36;
  let blink = 0;
  if (secondBlink) blink = Math.sin(((blinkPhase - period + 0.52) / 0.16) * Math.PI);
  else if (blinkPhase > period - 0.2)
    blink = Math.sin(((blinkPhase - period + 0.2) / 0.2) * Math.PI);
  const strength = Number.isFinite(level) ? Math.max(0, Math.min(1, (level - 0.008) * 5)) : 0;
  const tempo = id === 'agent_BSOLa3eNEZyjs-7abCjMt' ? 0.8 : 1;
  return {
    characterId: id,
    active: true,
    brow:
      strength * (0.35 + 0.25 * Math.sin(t * 0.65 * tempo)) +
      Math.max(0, Math.sin(t * 0.43 * tempo)) * 0.12 * (1 - strength),
    mouth: Number.isFinite(level) ? Math.max(0, Math.min(1, (level - 0.008) * 5)) : 0,
    blink,
    tilt: Math.sin(t * 0.3 * tempo) * 0.28 + Math.sin(t * 0.7 * tempo) * 0.32,
    nod: Math.sin(t * 1.1 * tempo) * (0.18 + strength * 0.4),
  };
}

export function messageCharacterId(message) {
  if (!message || message.isCreatedByUser) return null;
  return (
    [message.agent_id, message.model].find(
      (id) => typeof id === 'string' && /^agent_[A-Za-z0-9_-]{1,100}$/.test(id),
    ) || null
  );
}
