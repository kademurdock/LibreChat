const profiles = Object.freeze({
  agent_6llV0eMu4fmIaj8f2x1Sb: { tempo: 1, energy: 1, phase: 0.7 },
  'agent_BSOLa3eNEZyjs-7abCjMt': { tempo: 0.72, energy: 0.72, phase: 2.1 },
  agent_JhouuajXMYsfhCTVMQCv_: { tempo: 1.18, energy: 1.15, phase: 3.4 },
  agent_d26Mtu8mgOzkVGQECqO1a: { tempo: 0.83, energy: 0.82, phase: 4.8 },
});

/** Deterministic continuous gestures: sampling/pausing never creates random jumps. */
export function presencePose(id, time, strength = 0, expression = 'neutral') {
  const rest = { tilt: 0, nod: 0, scale: 1, tiltLimit: 1.4, nodLimit: 1.8 };
  const profile = profiles[id];
  if (!profile || !Number.isFinite(time) || time < 0) return rest;
  const voice = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
  const quiet = ['sad', 'tired', 'serious', 'concerned', 'afraid'].includes(expression) ? 0.45 : 1;
  const t = time * profile.tempo + profile.phase;
  const energy = profile.energy * quiet;
  const beat = t % 8.6;
  const nod = beat > 6.7 ? Math.sin((beat - 6.7) / 1.9 * Math.PI) ** 2 : 0;
  return {
    tilt: (Math.sin(t * 0.43) * 0.75 + Math.sin(t * 0.19) * 0.45) * energy,
    nod: (nod * 1.5 + Math.sin(t * 1.25) * voice * 0.65) * energy,
    scale: 1.012 + Math.sin(t * 0.85) * 0.004 + voice * 0.012 * quiet,
    tiltLimit: 2.8,
    nodLimit: 3.2,
  };
}
