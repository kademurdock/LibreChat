const mongoose = require('mongoose');

/**
 * KadeVoicePreset — a Voice Changer preset a person built themselves (Oct 22 2026).
 * Route: /api/kade/voice-changer/presets. The built-in presets live in the
 * engine (api/server/kadeVoiceChanger/engine/presets); these are the person's own
 * racks: a chain of effects, the macro settings and a background.
 *
 *   - name    : what the person called it (60 characters at most)
 *   - about   : an optional sentence (160 at most)
 *   - chain   : 1 to 12 stages, [{ m: 'family.name', p: { setting: value }, off? }];
 *               every effect and setting is checked against engine/modules.json on save
 *   - macros  : { pitch, timbre, speed, amount, width, volume, bed } (render.js opts.macros)
 *   - bed     : { b, level, p, duck, fade } (a made background) or { file, level, duck, fade }
 *               (a recorded one from soundBeds.json), or null
 *   - side    : a recorded sound id from soundBeds.json for effects that use "the other sound"
 *   - seed    : the random seed, so a preset sounds the same every time
 *   - shared  : the person offered it to everyone; others see it with the owner's first name
 *
 * At most 1,000 per person (the route enforces it). Same no-TS-build pattern as kadeAsset.js.
 * Collection 'kadevoicechangerpresets', named like kadevoicechangerprefs so neither can be
 * mistaken for the per-character voice picks in 'kadevoiceprefs' (kadeVoicePref.js).
 */
const kadeVoicePresetSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    name: { type: String, maxlength: 60 },
    about: { type: String, maxlength: 160, default: '' },
    chain: { type: mongoose.Schema.Types.Mixed },
    macros: { type: mongoose.Schema.Types.Mixed },
    bed: { type: mongoose.Schema.Types.Mixed },
    side: { type: String },
    seed: { type: mongoose.Schema.Types.Mixed },
    shared: { type: Boolean, default: false, index: true },
    /* the engine version the preset was made with, for any later migration */
    engineVersion: { type: String },
  },
  { timestamps: true, minimize: false },
);
kadeVoicePresetSchema.index({ user: 1, updatedAt: -1 });
kadeVoicePresetSchema.index({ shared: 1, createdAt: -1 });

const KadeVoicePreset =
  mongoose.models.KadeVoicePreset ||
  mongoose.model('KadeVoicePreset', kadeVoicePresetSchema, 'kadevoicechangerpresets');

module.exports = { KadeVoicePreset };
