export function voiceMessagePose({ id, time, level = 0, active }) {
  const still = { characterId: id, active: false, mouth: 0, blink: 0, brow: 0, tilt: 0, nod: 0 };
  if (!active || !Number.isFinite(time) || time < 0) return still;
  let seed = 5381;
  for (const byte of new TextEncoder().encode(id || 'unknown'))
    seed = (Math.imul(seed, 33) + byte) >>> 0;
  const t = time + ((seed % 1000) / 1000) * 4.7,
    blinkPhase = t % 4.7;
  const strength = Number.isFinite(level) ? Math.max(0, Math.min(1, (level - 0.008) * 5)) : 0;
  const tempo = id === 'agent_BSOLa3eNEZyjs-7abCjMt' ? 0.8 : 1;
  return {
    characterId: id,
    active: true,
    brow: strength * (0.35 + 0.25 * Math.sin(t * 0.65 * tempo)),
    mouth: Number.isFinite(level) ? Math.max(0, Math.min(1, (level - 0.008) * 5)) : 0,
    blink: blinkPhase > 4.5 ? Math.sin(((blinkPhase - 4.5) / 0.2) * Math.PI) : 0,
    tilt: Math.sin(t * 0.7 * tempo) * 0.6,
    nod: Math.sin(t * 1.1 * tempo) * (0.3 + strength * 0.4),
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
