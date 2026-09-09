# Ward playback levels, Part173

Gain-only copies of the ten existing installed ward background recordings.
Fetched from their authenticated sound-manifest links on 2026-09-09. No new
generative audio, layers, trimming, remixing or timing changes. Original B2
masters and database mappings are retained.

Original RMS across channels: 0.0033–0.0063, before player attenuation. Target
RMS 0.07 with a 0.49 sample-peak ceiling, whichever allows less gain. Actual
gain 16.47–25.18 dB. AAC 192 kbps preserves stereo and source sample rate.
Post-encode decoding verifies equal sample counts and peak <0.55. Before/after
measurements and exact original/playback SHA256 hashes are in levels.json.

Only the exact original Backblaze bucket/path keys resolve to these copies.
Other hosts, replacement filenames and room-tone recordings retain their own
URLs. The new path makes existing phone caches fetch the revised playback copy.

Source and gain checks do not establish human listening acceptance or native
VoiceOver/audio routing. Reproduction script is retained in the session work
folder as level_ambience.py; original downloads remain in session outputs.
