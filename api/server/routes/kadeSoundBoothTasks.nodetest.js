'use strict';
/* Clean up or change on AuK (Nov 15 2026): kadeSoundBoothTasks.js, the chain's hand-off, and the page's controls.
 * No network, no GPU, no database. Route-level tests are in kadeSoundBoothAukDesk.nodetest.js
 * (search "Clean up or change"); the bridge builds and tests the exact AuK templates (auk-tasks.test.js).
 * Run: node --test kadeSoundBoothTasks.nodetest.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tasks = require('./kadeSoundBoothTasks');
const words = require('./kadeSoundBoothWords');

const plan = (b, seconds = 10) => tasks.planTask(b, seconds, { looksLikeWordChange: words.looksLikeWordChange });

test('the task ids and their choices are the bridge\'s (auk-tasks.js), word for word', () => {
  assert.deepEqual(tasks.TASK_IDS, ['clean_up', 'restore_muffled', 'remove_effect', 'keep_singing', 'keep_voices', 'keep_speaker', 'speed', 'pitch', 'volume', 'emotion', 'whisper_to_normal', 'remove_accent', 'remove_sound', 'voice']);
  assert.deepEqual(Object.fromEntries(tasks.TASK_IDS.map((id) => [id, tasks.TASKS[id].slots])), {
    clean_up: {}, restore_muffled: {}, remove_effect: { effect: ['phone', 'megaphone', 'underwater'] },
    keep_singing: {}, keep_voices: {}, keep_speaker: { speaker: [1, 2, 3] },
    speed: { speed: [0.5, 0.75, 1.25, 1.5, 2] }, pitch: { direction: ['up', 'down'], semitones: [1, 2, 3] },
    volume: { direction: ['up', 'down'], db: [5, 10, 15] },
    emotion: { emotion: ['happy', 'angry', 'sad', 'fearful', 'surprised', 'disgusted', 'calm', 'excited'] },
    whisper_to_normal: {}, remove_accent: {}, remove_sound: { sound: ['breaths', 'laughs', 'sighs', 'coughs', 'ums'] },
    voice: { description: 'text' },
  });
});

test('a task from the page is checked, its choices come back as numbers, and her library gets one plain line', () => {
  assert.deepEqual(plan({ fix_task: 'clean_up' }), { task: 'clean_up', slots: {}, caption: 'Clean up noise and echo.', genSeconds: null });
  assert.deepEqual(plan({ fix_task: 'keep_speaker', fix_speaker: '2' }), { task: 'keep_speaker', slots: { speaker: 2 }, caption: 'Keep only the second person to talk.', genSeconds: null });
  assert.deepEqual(plan({ fix_task: 'pitch', fix_direction: 'up', fix_semitones: '1' }).caption, 'Raise the pitch by 1 semitone.');
  assert.deepEqual(plan({ fix_task: 'volume', fix_direction: 'down', fix_db: '15' }).slots, { direction: 'down', db: 15 });
  assert.equal(plan({ fix_task: 'volume', fix_direction: 'down', fix_db: '15' }).caption, 'Make it 15 decibels quieter.');
  assert.equal(plan({ fix_task: 'remove_effect', fix_effect: 'underwater' }).caption, 'Remove the underwater, muffled sound.');
  assert.equal(plan({ fix_task: 'remove_sound', fix_sound: 'ums' }).caption, 'Remove the ums and uhs.');
  assert.equal(plan({ fix_task: 'emotion', fix_emotion: 'calm' }).caption, 'Make it sound calm.');
  assert.equal(plan({ fix_task: 'voice', fix_description: 'a bright\n"young" woman' }).slots.description, "a bright 'young' woman");
  /* only the slots the task has are kept: a stray choice from another task never rides along */
  assert.deepEqual(plan({ fix_task: 'restore_muffled', fix_speed: '2', fix_emotion: 'sad' }).slots, {});
});

test('the result\'s length follows the task: speed sets it, mood and removed sounds nudge it, the rest keep it', () => {
  assert.equal(plan({ fix_task: 'speed', fix_speed: '1.25' }).genSeconds, 8);
  assert.equal(plan({ fix_task: 'speed', fix_speed: '0.5', edit_start: 2, edit_end: 5 }).genSeconds, 6);
  assert.equal(plan({ fix_task: 'speed', fix_speed: '2', edit_start: 4 }, 10).genSeconds, 3, 'to the end of the recording');
  assert.equal(plan({ fix_task: 'emotion', fix_emotion: 'sad' }).genSeconds, 12.2);
  assert.equal(plan({ fix_task: 'remove_sound', fix_sound: 'breaths' }).genSeconds, 9.4);
  assert.equal(plan({ fix_task: 'pitch', fix_direction: 'up', fix_semitones: '3' }).genSeconds, null);
});

test('keep one speaker is held to one short stretch, since "first to talk" would change from section to section', () => {
  assert.throws(() => plan({ fix_task: 'keep_speaker', fix_speaker: '1' }, 30), /^Error: Keep one speaker works on 14 seconds or less at a time\. Set Edit from second and Edit to second around that stretch\.$/);
  assert.equal(plan({ fix_task: 'keep_speaker', fix_speaker: '1', edit_start: 10, edit_end: 24 }, 30).slots.speaker, 1);
  assert.equal(plan({ fix_task: 'keep_speaker', fix_speaker: '3' }, 14).slots.speaker, 3);
});

test('anything off the lists is refused in one plain sentence', () => {
  const no = (b, message) => assert.throws(() => plan(b), (e) => e.message === message);
  no({}, 'Pick what to do with the recording.');
  no({ fix_task: 'constructor' }, 'Pick what to do with the recording.');
  no({ fix_task: 'speed', fix_speed: '3' }, 'Choose a new speed from the list.');
  no({ fix_task: 'pitch', fix_direction: 'up', fix_semitones: '7' }, 'Choose how many semitones from the list.');
  no({ fix_task: 'pitch', fix_semitones: '2' }, 'Choose up or down from the list.');
  no({ fix_task: 'emotion', fix_emotion: 'smug' }, 'Choose an emotion from the list.');
  no({ fix_task: 'remove_effect', fix_effect: 'radio' }, 'Choose an effect to remove from the list.');
  no({ fix_task: 'remove_sound', fix_sound: 'sneezes' }, 'Choose the sound to remove from the list.');
  no({ fix_task: 'keep_speaker', fix_speaker: '4' }, 'Choose the speaker to keep from the list.');
  no({ fix_task: 'voice' }, 'Describe the new voice first.');
  no({ fix_task: 'voice', fix_description: 'x'.repeat(301) }, 'Keep the voice description under 300 characters.');
  no({ fix_task: 'voice', fix_description: 'change the words to hello' }, 'Describe only the voice. To change words, choose change words under Task.');
});

test('each section of a long recording is sent the same task id and choices, and no instruction', async () => {
  const sent = [];
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBoothChain.js'), 'utf8'), {
    module: mod, exports: mod.exports, console, Buffer, URL,
    process: { env: { BRIDGE_SECRET: 'offline-fixture', KADE_BRIDGE_URL: 'https://bridge.invalid' } },
    require: (name) => name === 'axios' ? { post: async (url, body) => { sent.push({ url, body }); return { data: { jobId: 'job-1' } }; } }
      : name === './kadeSoundBoothStitch' ? {} : name === '@librechat/data-schemas' ? { logger: { info() {}, warn() {}, error() {} } } : require(name),
  });
  const opts = { auk_task: 'edit', edit_kind: 'task', edit_task: 'speed', edit_slots: { speed: 2 }, seed: 99, gen_seconds: 20, edit_start: 0, edit_end: 40, reference_voice_url: 'https://example.invalid/a.wav' };
  const r = await mod.exports.submitPart({ userId: 'u', script: 'Change the speed to 2 times.', opts, partIndex: 0, total: 2 });
  assert.equal(r.jobId, 'job-1');
  assert.equal(sent[0].url, 'https://bridge.invalid/audio/scenema/start');
  assert.equal(sent[0].body.edit_task, 'speed');
  assert.deepEqual(sent[0].body.edit_slots, { speed: 2 });
  assert.equal(sent[0].body.instruction, undefined);
  assert.equal(sent[0].body.seed, 99);
  assert.equal(sent[0].body.gen_seconds, 20);
});

/* ---------- the page ---------- */
function buildPage() {
  const context = {
    module: { exports: {} },
    require: (name) => (name === './kadePages' ? { SHARED_HEAD: '<meta charset="utf-8">' } : require(path.join(__dirname, name))),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'kadeSoundBoothPage.js'), 'utf8'), context);
  return context.module.exports.soundBoothHtml;
}
const html = buildPage();
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('function confirmRender('));
function pageFunction(name) {
  const start = script.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  let depth = 0;
  for (let i = script.indexOf('{', start); i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
/* The guide's own settings, as the page receives them. */
const GUIDE_SETTINGS = [
  { key: 'fix_task', kind: 'choice', default: 'clean_up' },
  { key: 'fix_speed', label: 'New speed', kind: 'choice', default: '0.75', forTasks: ['speed'] },
  { key: 'fix_direction', label: 'Up or down', kind: 'choice', default: 'up', forTasks: ['pitch', 'volume'] },
  { key: 'fix_semitones', label: 'Semitones', kind: 'choice', default: '1', forTasks: ['pitch'] },
  { key: 'fix_description', label: 'New voice', kind: 'text', forTasks: ['voice'] },
];

test('choices name their options in plain words, and only the boxes the picked change needs are shown', () => {
  const field = pageFunction('settingField');
  assert.match(field, /var lab = s\.labels&&s\.labels\[o\]!=null\?String\(s\.labels\[o\]\):o===''\?'None':o\.replace\(\/_\/g,' '\);/);
  assert.match(field, /'<select id="'\+id\+'" data-key="'\+s\.key\+'" aria-describedby="'\+id\+'_h/, 'every box keeps its label and hint');
  const settings = pageFunction('renderSettings');
  assert.match(settings, /if\(!fixing&&s\.key\.indexOf\('fix_'\)===0\)return false;/);
  assert.match(settings, /if\(fixing&&s\.forTasks&&s\.forTasks\.indexOf\(fixTask\(\)\)<0\)return false;/);
  assert.match(settings, /if\(\(task==='change_words'\|\|fixing\)&&s\.key==='seed'\)return false;/);
  assert.match(settings, /if\(task!=='edit'&&!fixing&&\['edit_start','edit_end'\]\.indexOf\(s\.key\)>=0\)return false;/, 'Edit from and Edit to stay for a clean-up');
  assert.match(script, /el\.dataset\.key==='fix_task'\)\{renderSettings\(\);document\.getElementById\(el\.id\)\.focus\(\);\}/, 'focus stays on What to do');
  assert.match(script, /if\(el\.dataset\.key==='fix_task'&&fixNext\(\)\) say\(fixNext\(\)\);/);
});

test('after a change is picked, the next step is said in one plain sentence; untouched boxes send what they show', () => {
  const ctx = { state: { values: {}, clips: [], guide: { engines: { scenema: { settings: GUIDE_SETTINGS } } } }, said: [], focused: [] };
  ctx.say = (text, alert) => ctx.said.push([text, !!alert]);
  ctx.document = {
    getElementById: (id) => (id === 'settingsDrawer' ? {} : { focus: () => ctx.focused.push(id) }),
    querySelector: () => ({ focus: () => ctx.focused.push('file') }),
  };
  vm.runInNewContext(['fixSetting', 'fixTask', 'fixNext', 'fixDefaults', 'fixReady'].map(pageFunction).join('\n') + '\nthis.f={fixTask,fixNext,fixDefaults,fixReady};', ctx);
  const f = ctx.f;
  assert.equal(f.fixTask(), 'clean_up');
  assert.equal(f.fixNext(), '', 'a clean-up needs nothing more');
  ctx.state.values.fix_task = 'pitch';
  assert.equal(f.fixNext(), 'Next, choose Up or down, then Semitones, below.');
  ctx.state.values.fix_task = 'speed';
  assert.equal(f.fixNext(), 'Next, choose New speed, below.');
  ctx.state.values.fix_task = 'voice';
  assert.equal(f.fixNext(), 'Next, describe the new voice below.');
  assert.deepEqual({ ...f.fixDefaults({ fix_task: 'speed' }) }, { fix_task: 'speed', fix_speed: '0.75', fix_direction: 'up', fix_semitones: '1' });
  assert.deepEqual({ ...f.fixDefaults({}) }.fix_task, 'clean_up');
  /* not ready: no recording, then a voice change with no description */
  assert.equal(f.fixReady(), false);
  assert.deepEqual(ctx.said.at(-1), ['Import the recording you want to clean up or change.', true]);
  ctx.state.clips = [{ url: 'https://example.invalid/a.wav' }];
  assert.equal(f.fixReady(), false);
  assert.deepEqual(ctx.said.at(-1), ['Describe the new voice first.', true]);
  assert.equal(ctx.focused.at(-1), 'set_fix_description');
  ctx.state.values.fix_description = 'a deep voice';
  assert.equal(f.fixReady(), true);
});

test('the page sends the change as choices, never the voice seed, and offers it on every take and starter button', () => {
  assert.match(script, /if\(state\.engine==='scenema' && b\.auk_task==='clean_up_or_change'\) fixDefaults\(b\);/);
  assert.match(script, /b\.auk_task!=='change_words' && b\.auk_task!=='clean_up_or_change'\) b\.seed = state\.voiceSeed;/);
  assert.match(script, /if\(state\.engine==='scenema' && sent\.auk_task==='clean_up_or_change' && !fixReady\(\)\) return;/);
  assert.match(script, /if\(state\.engine==='scenema' && state\.values\.auk_task==='clean_up_or_change'\) return 'Change the recording';/);
  assert.match(script, /data-use="clean_up_or_change">Clean up or change this take<\/button>/);
  assert.match(script, /button\.dataset\.use==='clean_up_or_change'\?'Take attached\. Pick what to do\. The original is kept\.'/);
  assert.match(script, /button\.dataset\.use==='clean_up_or_change'\?'set_fix_task'/);
  /* a starter button fills What to do and its choices, focuses it, and says what was chosen */
  assert.match(script, /state\.values\.fix_task=recipe\.fix; Object\.keys\(recipe\.slots\|\|\{\}\)\.forEach/);
  assert.match(script, /document\.getElementById\('set_fix_task'\)\.focus\(\);\s*say\(recipe\.label\+' is chosen\. Nothing is made until you choose '\+renderLabel\(\)\+'\.'\); return;/);
  /* a reopened project comes back on the same change */
  assert.match(script, /p\.options\.edit_kind==='task'\)\{\s*state\.values\.auk_task='clean_up_or_change'; state\.values\.fix_task=p\.options\.edit_task;/);
});
