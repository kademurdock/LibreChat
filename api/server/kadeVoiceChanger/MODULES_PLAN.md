# Voice Changer — module families (the builders' brief)

Each family is one builder. Ids are `family.name` and stable forever. The
param lists are a starting point: add what makes the effect fun to play with,
keep names plain and spoken, keep 2–8 params per module. Every module gets a
property test that proves it does what its name says (see "Prove it" lines).
Ideas from the old voice changers (MorphVOX, AV Voice Changer, Clownfish),
plugin racks (vocoders, pitch correction, tape and lo-fi emulations) and
broadcast/film sound design — all built from published techniques, never
from anyone's code.

## 1. pitch — voices (core/voice.js, core/pv.js)
- `pitch.voice` Pitch and timbre: semitones, formant, mode (natural|fast).
- `pitch.speed` Tape speed: speed x (0.25..4) — pitch and tempo together (chipmunk, slow-motion drawl).
- `pitch.tempo` Tempo without pitch: factor (0.25..4).
- `pitch.vibrato` Vibrato: rate hz, depth cents, delay onset ms, shape (sine|triangle|random).
- `pitch.wobble` Warble and drift: depth cents, speed, randomness (drunk, wobbly tape voice, nervous).
- `pitch.glide` Rising or falling: from semitones, to semitones, curve — over the whole clip.
- `pitch.flatten` Monotone: note (hz or musical note), amount percent, keep intonation percent (robot monotone, bored voice).
- `pitch.correct` Pitch correction: key, scale (major minor chromatic pentatonic blues dorian harmonic-minor whole-tone), retune speed ms (0 = hard robotic snap), humanize percent, formant follow.
- `pitch.harmony` Harmony voices: chord (octave-up, octave-down, fifth, major, minor, power, sus, choir-of-octaves, barbershop, diminished...), voices count, spread (stereo), detune cents, timing spread ms, mix.
- `pitch.octaver` Octave stack: down-one level, down-two level, up-one level (monk choir, giant chorus).
- `pitch.subharmonic` Growl and fry: subharmonic level, roughness, fry (creaky voice), (demons, zombies, gravel).
- `pitch.jitter` Cracking voice: crack rate, crack size semitones, jitter cents (teenage voice break, nervous).
- `pitch.arp` Melody voice: notes (pattern choices: up, down, up-down, random, chord tones), rate per second, glide — sings your speech along a melody.
- `pitch.helium` Gas voices: gas (helium | heavy gas), amount — formant-only shifts the real gases make.
Prove it: measured f0 and formant ratios, durations, correction snaps to scale notes.

## 2. spectral — STFT magic (core/stft.js)
- `spec.robot` Robotizer: buzz pitch hz, frame size, mix (phase zeroing — constant-pitch robot).
- `spec.whisper` Whisperizer: amount, size (phase randomisation — voiceless whisper).
- `spec.freeze` Spectral freeze: hold length ms, interval ms, blend (stuck, frozen, glassy smears).
- `spec.blur` Spectral smear: amount, time spread (dream voice, ghost).
- `spec.shift` Spectral shift: hz (linear bin shift, inharmonic alien), mix.
- `spec.stretch` Spectral stretch: factor (spread/compress harmonics — bell-like, metallic).
- `spec.invert` Mirror spectrum: around hz (inside-out voice), mix.
- `spec.crystal` Crystallize: peaks kept, sustain — only spectral peaks survive (glass, ice).
- `spec.thin` Spectral gate: threshold, keep loud or keep quiet (skeleton voice, wispy).
- `spec.comb` Harmonic comb: base hz, sharpness (voice through a tuned comb — choral, metallic chord).
- `spec.codec` Bad internet audio: bitrate feel (8..64 kbps-like band dropping and quantised bins), warble (the underwater-robot sound of a weak video call).
- `spec.dropout` Glitchy call: loss percent, burst length, concealment (repeat | robot | silence) — packet loss with concealment artefacts.
- `spec.paul` Extreme stretch: factor (2..50), window seconds — ambient endless voice clouds (published "extreme time stretch" method).
- `spec.morph` Cross-synthesis: carrier (The other sound | wind | rain | fire | engine | ocean | crowd-noise | synth-pad | organ | bells), amount — your words spoken BY the storm, the fire, a song or any sound (built-in carriers generated internally with core noise/synthesis; "The other sound" uses ctx.side).
- `spec.blend` Half you, half it: spectral morph between the voice and The other sound (magnitude and
  envelope interpolation with the voice's timing), blend percent, envelope from (voice | other | both),
  keep consonants.
Prove it: robot output is periodic at the buzz pitch; whisper is aperiodic but keeps the spectral envelope; freeze holds frames; codec removes high bands.

## 3. synth — vocoders, modulators, resonators
- `synth.vocoder` Channel vocoder: bands (8..64), carrier (saw, square, supersaw chord, pulse, noise, organ, choir pad, wind, or The other sound — a song, a guitar take, any recording), note or chord, root, attack/release, unvoiced pass-through, mix.
- `synth.lpc` Speech chip: order, rate (8 kHz, 10 kHz), excitation (buzz, noise, buzz+noise, monotone), coefficient bits — the 1970s talking learning toy, the 2400 bit-per-second military secure phone, the arcade speech chip.
- `synth.talkbox` Talk box — Kade asked for a LEGIT one (Oct 22 2026), so build it like the real thing:
  an instrument is shaped by the speaker's mouth, so the INSTRUMENT talks. High-resolution vocal-tract
  analysis (LPC order about sr/1000 + 4, pre-emphasis, short frames with overlap, or a cepstral
  envelope) applied to a rich carrier; formant smoothing so it glides like a real mouth; a tube/mouth
  resonance colour; consonant bleed (the real talk-box mic hears a little of the actual "s", "t", "k":
  mix the high-passed unvoiced original back in, about -12 dB, gated to unvoiced frames) so words stay clear.
  Carriers: smooth funk synth lead (detuned saw, gentle low-pass, portamento — the classic early-80s
  talk box), square/pulse lead with slow PWM, fuzz guitar through an amp and cabinet, organ, bass synth,
  8-bit square chip lead. Note source (param `notes`): follow my voice (tracked f0 snapped to `key`/`scale`
  with `glide` ms; unvoiced stretches hold the last note), chord (root + chord type, stacked carriers),
  melody pattern (riffs in key at `tempo`), single held note. Params: instrument, notes, key, scale, glide,
  chord, tempo, brightness, consonants (bleed level), drive, mix. Prove it: the output's pitch follows the
  note source, not the voice (unless follow mode), and the vowel envelope tracks the input (formant
  correlation with the input envelope clearly above a plain carrier).
  The talk box also takes "The other sound" (CONTRACT side input) as its instrument: a real guitar or
  synth recording becomes the talking instrument.
- NOT built (Kade, Oct 22 2026): a voice-to-instrument effect that replaces the voice with a synth
  following its pitch — her RVC tools already do that. Mixing the voice WITH other sounds is wanted.
- `synth.crossconv` Your voice inside another sound: convolution cross-synthesis (the voice is filtered
  through the other sound's spectrum, frame by frame, with spectral whitening of the voice), sources:
  The other sound, bells, gong, glass, thunder, rain, crowd, engine; amount, smoothing, mix.
- `synth.ringmod` Ring modulator: carrier hz, shape (sine square triangle, or The other sound), wobble rate, wobble depth, mix (the classic tin-voiced space invader).
- `synth.am` Tremolo depth/shape at audio rates, mix (gargle, insect wings).
- `synth.fm` Frequency wobble: rate hz, depth ms (delay-modulated FM — warbly alien, underwater).
- `synth.resonator` Resonator bank: tuning (bell, glass, metal plate, wood box, singing bowl, strings-major, strings-minor, steel drum, gong), decay, brightness, mix — your voice rings a physical object.
- `synth.strings` Sympathetic strings: tuning chord, decay, pluck brightness (Karplus–Strong strings excited by the voice).
- `synth.granular` Grain cloud: grain ms, density, pitch spread cents, position scatter, reverse chance, stereo spread (swarm, shimmer, broken memory).
- `synth.freqshift` Frequency shifter: hz (±2000), feedback, mix (single-sideband radio detune, uneasy alien).
- `synth.formantfilter` Vowel filter: vowel sequence (a-e-i-o-u patterns), rate, resonance (talking wah, mouth harp).
- `synth.kazoo` Kazoo and comb buzzers: buzz amount, membrane brightness.
Prove it: vocoder output pitch follows the carrier note, not the voice; ring mod produces sum/difference sidebands; resonator rings at its tuned frequencies.

## 4. lofi — distortion, bit depth, codecs, broken speakers
- `lofi.drive` Distortion: drive db, character (warm tube, fuzz, hard clip, fold, rectifier, crunch), tone, mix.
- `lofi.crush` Bit crusher: bits (1..16), sample rate hz (500..48000), anti-alias on/off, jitter.
- `lofi.speaker` Small speaker: size (earbud, phone, laptop, toy, radio, TV, PA horn, megaphone), rattle, volume push.
- `lofi.blown` Blown speaker: rattle, buzz, crackle.
- `lofi.companding` Phone-line coding: law (mu-law, A-law), rate 8 kHz, bits — the exact G.711 sound.
- `lofi.adpcm` 4-bit ADPCM (IMA): rate — old game and answering-machine samples.
- `lofi.console` Old console sound chip: system (8-bit console 1-bit delta at 33 kHz, 16-bit console 4-bit compressed samples with gaussian interpolation, 8-bit computer at 8 kHz, handheld 4-bit at 8 kHz, arcade 8-bit) — authentic-to-hardware sample coding (published hardware documentation), plus the system's typical echo where it had one.
- `lofi.mp3` Old internet file: quality (awful..ok) — MDCT-style band quantisation and pre-echo.
- `lofi.saturate` Tape saturation: drive, bias, head bump.
Prove it: crush reduces distinct levels; companding matches the formula; speaker band-limits per size.

## 5. device — telephones, radios, records, tapes (chains of the above, voiced as real devices)
- `device.phone` Telephone: era (1920s candlestick, 1950s rotary, 1980s cordless, 1990s cellular, 2000s flip phone with codec swirl, modern VoIP, speakerphone), line noise, hum, crackle, codec.
- `device.walkie` Walkie-talkie: squelch (open/close noise bursts at phrase starts and ends), roger beep (none/chirp/two-tone), clip, band.
- `device.cb` CB radio: skip (fading), heterodyne whistle, splatter, squelch.
- `device.radio` AM radio: tuning (on, slightly off, between stations), static, fading, whistle, era.
- `device.shortwave` Shortwave: sideband detune hz, fading speed, atmospheric noise, interference warble.
- `device.scanner` Police scanner: squelch tail, digital warble, chirps.
- `device.spaceradio` Space radio: beep tones at the start and end of each phrase (2525/2475 Hz), band-limit, hiss, delay.
- `device.intercom` Intercom and drive-thru: buzz, distortion, box resonance.
- `device.megaphone` Megaphone and bullhorn: horn resonance, siren chirp (off/on), push.
- `device.pa` PA system: venue (school gym, airport, train station, stadium, store), feedback ring, delay towers.
- `device.gramophone` Gramophone 78: horn, surface noise, crackle, wow, speed 78/80.
- `device.cylinder` Wax cylinder: hiss, groove noise, wobble, band.
- `device.vinyl` Vinyl record: crackle, pops, rumble, wow, warp.
- `device.cassette` Cassette: tape (ferric, chrome, worn), hiss, wow, flutter, dropouts, high loss, saturation, chewed tape.
- `device.microcassette` Answering machine tape: speed wobble, hiss, motor noise, beep.
- `device.vhs` VHS audio: linear track hiss, wobble, hum.
- `device.tincan` Tin-can string phone: string resonance, can ring.
- `device.babymonitor` Baby monitor: hiss, compander pumping, crackle.
- `device.toy` Talking toy: chip (speech chip, cheap sample), speaker, battery low (pitch sag).
- `device.tv` Old TV in the next room: hum, band-limit, room.
Prove it: each device's band limits, noises present, squelch bursts at phrase edges (core/segment.js).

## 6. mod — modulation, rhythm and choppers
- `mod.chorus` Chorus: voices, depth, rate, spread, mix.
- `mod.flanger` Flanger: rate, depth, feedback (positive/negative), mix (jet plane).
- `mod.phaser` Phaser: stages, rate, depth, feedback, mix.
- `mod.tremolo` Tremolo: rate, depth, shape, stereo phase.
- `mod.autopan` Auto-pan: rate, width, shape.
- `mod.rotary` Rotating speaker: speed (slow, fast, ramp), horn/drum balance, drive.
- `mod.autowah` Envelope filter: sensitivity, range, resonance, direction.
- `mod.gate` Rhythm gate: pattern (16 steps, presets: trance, stutter, morse, heartbeat), tempo bpm, smoothing.
- `mod.chopper` Chopper: rate hz (helicopter 12–25 Hz, fan 30–60 Hz), depth, blade shape, rotor wobble — talking through helicopter blades or into a fan.
- `mod.doppler` Pass-by pitch: speed, closest distance, direction — the voice zooms past.
- `mod.underwater` Underwater: depth (muffling), bubbles, wobble.
- `mod.keyed` Keyed by your voice: The other sound (or a built-in pad, rain, crowd, engine, drone)
  plays only while you talk (gate) or dips under you (duck) or swells with you (follow), with
  attack, release, depth, and how much of your own voice stays in.
Prove it: modulation rates measurable in the envelope; chopper amplitude periodicity at its rate.

## 7. time — reversing, stuttering, rearranging
- `time.reverse` Backwards: whole clip.
- `time.reversewords` Backwards words: each phrase or syllable reversed in place (core/segment.js) — speech that sounds like a secret language.
- `time.palindrome` There and back: forward then backward.
- `time.stutter` Stutter: repeats, piece length ms, where (word starts, random, everywhere).
- `time.tapestop` Tape stop: when (end, each phrase, random), stop time ms; also tape start.
- `time.scratch` Record scratch: pattern, speed.
- `time.glitch` Glitch: buffer repeats, reverse chance, pitch jumps, density (beat-repeat style).
- `time.shuffle` Scrambled order: unit (phrases, syllables), amount — messages that come out jumbled.
- `time.trim` Close the gaps: remove silences over ms, keep ms (fast talker).
- `time.drawl` Slow-motion stretch: factor with pitch kept or dropped.
Prove it: reverse equals the reversed input; reversewords keeps phrase boundaries; trim shortens by the pause lengths.

## 8. echo and stereo — delays, reverse echoes, width, 3D (core/delay.js, core/space3d.js)
- `echo.delay` Echo: time ms or tempo division, feedback, damping, stereo (mono, ping-pong, wide), wobble (tape), mix.
- `echo.multitap` Multi-tap: pattern (rhythmic choices), spread, feedback.
- `echo.reverse` Reverse echo: each echo plays backwards, length, feedback, mix.
- `echo.preverb` Reverse reverb swell: the reverb tail comes BEFORE each word (ghostly pre-echo), length, space.
- `echo.canyon` Canyon calls: distance, count, brightness loss.
- `echo.dub` Dub delay: feedback near runaway, filter sweep, spring splash.
- `echo.slapback` Slapback: time, level (old rock and roll, stadium slap).
- `stereo.width` Width: amount (0 mono .. 200 extra wide), mid/side balance.
- `stereo.haas` Haas widen: delay ms, side.
- `stereo.double` Double-track: copies, timing variance ms, pitch variance cents, spread.
- `stereo.crowd` Crowd of you: people (2..40), pitch spread semitones, timbre spread, timing spread ms, spread, room — a choir, a mob, an army, all you.
- `stereo.split` Split personality: left (pitch semitones, timbre), right (pitch, timbre), alternate mode (off, per phrase).
- `stereo.place` Put the voice somewhere: angle degrees, height degrees, distance m (behind you, whispering in your left ear, across the room).
- `stereo.orbit` Circling head: rounds per minute, distance, height, direction (the 3D headphone effect).
- `stereo.flyby` Fly-by: start angle, end angle, speed, closest distance (with doppler).
- `stereo.walkaway` Walking away or toward: start distance, end distance, angle, room.
- `stereo.pingpong` Ping-pong phrases: each phrase alternates ears.
Prove it: width 0 gives correlation 1; place +90 gives right-ear dominance; orbit alternates.

## 9. space — rooms and places (core/ir.js, core/conv.js)
- `space.room` Room: space (every named IR), mix, distance (dry/wet + early level), predelay, size scale.
- `space.reverb` Algorithmic reverb: size, decay seconds, damping, predelay, modulation, mix (FDN, also the base for live mode later).
- `space.shimmer` Shimmer: octave up/fifth, decay, mix (angelic, heavenly).
- `space.gated` Gated reverb: size, gate ms (80s drum-gate on a voice).
- `space.spring` Spring tank: springs, drip, mix (surf radio).
- `space.muffle` Through a wall: wall (door, thin wall, thick wall, floor above, closet door, car window), room behind.
- `space.distance` Far away: distance m, outdoors on/off.
- `space.telephonebox`, etc. are presets, not modules.
Prove it: tails add the right decay time (measured RT60 within 30%), muffle removes highs.

## 10. tone and dynamics — EQ, compression, cleanup (production tools)
- `tone.eq` Equalizer: up to 6 bands (type, freq, gain, q) as flat params (band1Freq, band1Gain...).
- `tone.tilt` Tilt: darker/brighter amount, pivot.
- `tone.filter` Filter: type (low pass, high pass, band pass, notch), freq, resonance, sweep (static, slow sweep, envelope).
- `tone.character` Character EQ: shape (radio voice, warm and close, bright and airy, nasal, thin, boomy, honky, telephone, muffled, presence).
- `tone.compress` Compressor: threshold, ratio, attack, release, makeup.
- `tone.broadcast` Broadcast processor: density (the loud, close, radio-announcer sound — multiband compression + limiter + presence).
- `tone.deess` De-esser: threshold, frequency.
- `tone.gate` Noise gate: threshold, release.
- `tone.denoise` Noise reduction: amount, learn from (quietest stretch) — spectral subtraction with musical-noise smoothing.
- `tone.dehum` Hum removal: 50 Hz / 60 Hz, harmonics.
- `tone.declick` Click and pop removal.
- `tone.loudness` Loudness: target LUFS.
- `tone.gain` Volume: db.
- `tone.mono` Make mono / swap channels.
Prove it: EQ responses within 1 dB; denoise lowers noise floor by >6 dB on speech+noise; gate silences pauses.

## 11. beds — backgrounds (beds/<id>.js, synthesis only)
Weather: rain (light, heavy, on a window, on a tin roof, on a tent, on leaves), storm (rain + rolling and cracking thunder with distance), wind (gentle, howling, gusty, through trees, blizzard, desert), hail.
Water: ocean waves (beach, rocky shore, calm), river, creek, waterfall, dripping cave, underwater, rain gutter, fountain.
Fire: campfire, fireplace, crackling torch, roaring blaze.
Nature: forest birds (procedural birdsong: chirp, trill and warble grammars), jungle (birds + insects + frogs + distant howls), night (crickets, katydids, frogs, owl), summer field (cicadas, bees), swamp, farmyard morning (rooster-ish crow, clucks — only if convincing), wolves far off.
Places: city street (traffic swell, horns, distant siren), subway platform, airport hall, office (HVAC, keyboard clicks, distant phone), café (murmur + cups), restaurant kitchen, school hallway, hospital (monitor beeps), factory (rhythmic machinery), construction, arcade hall (bleeps), casino floor, carnival, stadium crowd, library hush, laundromat, server room hum, refrigerator hum.
Vehicles: car interior at highway speed, rain on a car roof, bus, train (clackety rhythm, horn far off), subway car, airplane cabin (engine roar, chime), helicopter cabin, boat engine, sailboat creak, spaceship bridge (hum, chirps, beeps), engine room, submarine (sonar pings, hull groans), rocket launch rumble.
Spooky: haunted house (creaks, wind, distant moans), graveyard night, dungeon (chains, drips), heartbeat, ticking clock, radio static, TV static, dial tone and line noise, theremin-ish whine.
Every bed: stereo, natural variation from rng, params for intensity and distance where they make sense.

## Novel ideas worth building (not in the old voice changers)
- Words spoken BY a storm / fire / ocean (spec.morph).
- A crowd, choir or army made only of your voice (stereo.crowd).
- Era-accurate devices down to the coding chips (lofi.console, synth.lpc, lofi.companding, device.spaceradio).
- Places that MOVE: walking away down a hallway, a fly-by with doppler, circling your head.
- Backwards words that keep your rhythm (time.reversewords) and scrambled messages.
- Your voice ringing a bell, glass or set of strings (synth.resonator, synth.strings).
- Glitchy video call and bad internet (spec.codec, spec.dropout).
- Through the wall from the next room, with the room behind it (space.muffle).
