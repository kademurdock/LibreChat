import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCallCharacter } from './adapter.mjs';
import { observePlayback, clearPresentation, presentationStatus, createPresentationRelay } from './playback.ts';
import { readCharacterAudio } from './metadata.ts';

function harness() {
  let now = 0, id = 0, frame;
  const raf = new Map(), timers = new Map();
  const adapter = createCallCharacter({
    resolveProfile: id => id === 'kiana' ? { id, rigReady: true } : null,
    render: value => { frame = value; },
    requestFrame: callback => { raf.set(++id, callback); return id; },
    cancelFrame: id => raf.delete(id),
    setTimer: (callback, delay) => { timers.set(++id, { callback, at: now + delay / 1000 }); return id; },
    cancelTimer: id => timers.delete(id),
  });
  adapter.select('kiana');
  adapter.preferences({ enabled: true });
  return { adapter, raf, timers, frame: () => frame,
    advance(time) {
      now = time;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach(f => f());
    },
    segment(start = 0, speech = true, agentId = 'kiana') { return {
      start, speech, agentId, clock: () => now,
      buffer: { duration: 1, sampleRate: 8000, numberOfChannels: 1, length: 8000,
        getChannelData: () => Float32Array.from({ length: 8000 }, (_, i) => i < 4000 ? 0.2 : 0) },
    }; },
  };
}

test('actual scheduled audio opens mouth, its silence closes it, server listening waits for drain', () => {
  const h = harness();
  const first = h.adapter.scheduled(h.segment(1));
  const second = h.adapter.scheduled(h.segment(2));
  h.adapter.status('listening');
  h.advance(0.9); assert.equal(h.frame().mouth, 0);
  h.advance(1.2); assert.ok(h.frame().mouth > 0.1);
  h.advance(1.7); assert.equal(h.frame().mouth, 0);
  first(); assert.equal(h.frame().mode, 'speaking');
  h.advance(2.2); assert.ok(h.frame().mouth > 0.1);
  h.advance(3); second(); assert.equal(h.frame().mode, 'listening');
});

test('clear and stale end callbacks cannot change the new turn', () => {
  const h = harness();
  const old = h.adapter.scheduled(h.segment());
  h.adapter.clear();
  assert.equal(h.frame().mouth, 0);
  h.adapter.scheduled(h.segment());
  h.advance(0.2); old();
  assert.equal(h.frame().mode, 'speaking');
  assert.ok(h.frame().mouth > 0.1);
});

test('late artwork readiness waits for pending playback instead of dropping its ownership', () => {
  const h = harness();
  const ended = h.adapter.scheduled(h.segment(1));
  h.adapter.status('listening');
  h.adapter.refreshProfile();
  h.advance(1.2);
  assert.equal(h.frame().mode, 'speaking');
  assert.ok(h.frame().mouth > 0.1);
  h.advance(2); ended();
  assert.equal(h.frame().mode, 'listening');
  assert.equal(h.frame().mouth, 0);
});

test('unknown speaker and Spotter remain static; game clips close the mouth', () => {
  const h = harness();
  h.adapter.scheduled(h.segment(0, false));
  h.advance(0.2); assert.equal(h.frame().mouth, 0);
  h.adapter.scheduled(h.segment(1, true, 'other'));
  h.advance(1.2); assert.equal(h.frame().active, false);
  h.adapter.scheduled(h.segment(2, false, null));
  h.advance(2.2); assert.equal(h.frame().active, false);
});

test('hidden and reduced motion stop frames and dispose rejects late completions', () => {
  const h = harness(); const end = h.adapter.scheduled(h.segment());
  h.adapter.preferences({ visible: false }); assert.equal(h.raf.size, 0);
  h.adapter.preferences({ visible: true, reducedMotion: true }); assert.equal(h.raf.size, 0);
  h.adapter.preferences({ reducedMotion: false }); assert.equal(h.raf.size, 1);
  h.adapter.dispose(); end(); h.adapter.status('listening');
  assert.equal(h.raf.size, 0);
});

test('optional observers preserve audio onended and never throw into scheduling', () => {
  const source = new EventTarget(); let audioEnds = 0, visualEnds = 0;
  source.addEventListener('ended', () => audioEnds++);
  observePlayback({ scheduled() { return () => visualEnds++; } }, source, {});
  source.dispatchEvent(new Event('ended'));
  source.dispatchEvent(new Event('ended'));
  assert.equal(audioEnds, 2); assert.equal(visualEnds, 1);
  const broken = { scheduled() { throw Error('render'); }, clear() { throw Error('clear'); }, status() { throw Error('status'); } };
  assert.doesNotThrow(() => { observePlayback(broken, source, {}); clearPresentation(broken); presentationStatus(broken, 'idle'); });
});

test('metadata validates explicit speaker and speech; missing metadata never implies speech', () => {
  const good = { type: 'character-audio', version: 1, agentId: 'kiana', speech: true };
  assert.deepEqual(readCharacterAudio(good), good);
  for (const patch of [{ version: 2 }, { speech: 'true' }, { agentId: '' }, { agentId: 'x'.repeat(129) }]) {
    assert.equal(readCharacterAudio({ ...good, ...patch }), null);
  }
  assert.equal(readCharacterAudio({}), null);
});

test('a malformed clip cannot strand a speaking frame loop', () => {
  const h = harness();
  h.adapter.scheduled({ ...h.segment(), buffer: null });
  assert.equal(h.raf.size, 0);
  assert.equal(h.frame().mouth, 0);
});

test('replacement presentation is selected through the stable relay', () => {
  const calls=[];
  let current={clear:()=>calls.push('old')};
  const relay=createPresentationRelay(()=>current);
  relay.clear();
  current={clear:()=>calls.push('new')};
  relay.clear();
  assert.deepEqual(calls,['old','new']);
});

for (const preferences of [{}, { enabled: false }, { visible: false }, { reducedMotion: true }]) {
  test(`queued speakers change at playback start with ${JSON.stringify(preferences)}`, () => {
    const h = harness();
    h.adapter.preferences(preferences);
    h.adapter.scheduled(h.segment());
    h.adapter.scheduled(h.segment(1, true, 'other'));
    h.adapter.scheduled(h.segment(2, true, 'kiana'));
    assert.equal(h.frame().characterId, 'kiana');
    h.advance(.2);
    assert.equal(h.frame().characterId, 'kiana');
    if (!Object.keys(preferences).length) assert.ok(h.frame().mouth > .1);
    h.advance(.99); assert.equal(h.frame().characterId, 'kiana');
    h.advance(1.01); assert.equal(h.frame().characterId, 'other');
    assert.equal(h.frame().active, false);
    h.advance(2.02); assert.equal(h.frame().characterId, 'kiana');
    h.advance(3.03); assert.equal(h.frame().mouth, 0);
    assert.equal(h.timers.size, 0);
    h.adapter.dispose(); assert.equal(h.raf.size, 0);
  });
}

test('queued unknown speaker cannot cancel current speech and clear cancels future identities', () => {
  const h = harness();
  const end = h.adapter.scheduled(h.segment());
  const stale = h.adapter.scheduled(h.segment(1, true, 'other'));
  h.advance(.2); assert.ok(h.frame().mouth > .1);
  end(); assert.ok(h.frame().mouth > .1);
  h.adapter.clear();
  assert.equal(h.timers.size, 0);
  h.adapter.scheduled(h.segment(1));
  h.advance(1.2); stale();
  assert.equal(h.frame().characterId, 'kiana');
  assert.ok(h.frame().mouth > .1);
  h.adapter.dispose();
});

test('late boundary wakes skip expired speech and retain the last actually started identity', () => {
  const h = harness();
  h.adapter.scheduled(h.segment(0));
  h.adapter.scheduled(h.segment(1, true, 'other'));
  h.adapter.scheduled(h.segment(2));
  h.adapter.status('listening');
  h.advance(10);
  assert.equal(h.frame().characterId, 'kiana');
  assert.equal(h.frame().mode, 'listening');
  assert.equal(h.frame().mouth, 0);
  assert.equal(h.timers.size, 0);
  h.adapter.dispose();
});

test('malformed or overlapping future clips never preempt the active speaker', () => {
  const h = harness();
  h.adapter.scheduled(h.segment()); h.advance(.2);
  for (const start of [-1, NaN, Infinity, .5]) h.adapter.scheduled(h.segment(start, true, 'other'));
  h.adapter.scheduled({ ...h.segment(1, true, 'other'), buffer: null });
  assert.equal(h.frame().characterId, 'kiana'); assert.ok(h.frame().mouth > .1);
  assert.equal(h.timers.size, 1);
  h.adapter.dispose();
});

test('same-speaker chunks retain the blink cycle across audio boundaries', () => {
  const h = harness();
  const a = h.segment(), b = h.segment(3);
  a.buffer.duration = b.buffer.duration = 3;
  h.adapter.scheduled(a); h.adapter.scheduled(b);
  h.advance(3.1); h.advance(4.6);
  assert.ok(h.frame().blink > .9, 'a new audio chunk must not restart the blink clock');
  h.adapter.dispose();
});
