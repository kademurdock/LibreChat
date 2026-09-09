import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCallCharacter } from './adapter.mjs';
import { observePlayback, clearPresentation, presentationStatus, createPresentationRelay } from './playback.ts';
import { readCharacterAudio } from './metadata.ts';

function harness() {
  let now = 0, id = 0, frame;
  const raf = new Map();
  const adapter = createCallCharacter({
    resolveProfile: id => id === 'kiana' ? { id, rigReady: true } : null,
    render: value => { frame = value; },
    requestFrame: callback => { raf.set(++id, callback); return id; },
    cancelFrame: id => raf.delete(id),
  });
  adapter.select('kiana');
  adapter.preferences({ enabled: true });
  return { adapter, raf, frame: () => frame,
    advance(time) { now = time; const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach(f => f()); },
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
