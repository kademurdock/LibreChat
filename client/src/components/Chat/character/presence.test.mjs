import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { presencePose } from './presence.mjs';
import { styleAt, voiceMessagePose } from './voice-message-motion.mjs';
import { resolveFace, panelRect } from './face-sheet-rig.mjs';
import * as portraits from './portrait-rig.mjs';

test('new directions use distinct artwork and retain original fallback faces', () => {
  const panels = new Set();
  for (const expression of ['curious','thoughtful','playful','confident','tender','tired','serious','excited']) {
    const cue = [{ at: 0, expression, kind: 'direction' }];
    const face = styleAt(cue, 2, true).face;
    const ready = resolveFace(face.to, true);
    assert.equal(ready.source, 'nuance');
    panels.add(ready.panel);
    assert.equal(resolveFace(face.to, false).source, 'faces');
    assert.equal(resolveFace(face.to, false).panel, resolveFace(styleAt(cue, 2).face.to, false).panel);
  }
  assert.equal(panels.size, 8);
  assert.equal(styleAt([{at: 0, expression: 'amused', kind: 'moment'}], .3, true).face.to, 'laugh');
});

test('all four real identities have different continuous motion, and stop closes speech', () => {
  const signatures = new Set();
  for (const name of ['KIANA','DELLA','LILLY','HARLEY']) {
    const id = portraits[name + '_ID'];
    signatures.add(JSON.stringify(presencePose(id, 4, .4)));
    for (let i = 0; i < 2000; i++) {
      const time = i / 24;
      const pose = voiceMessagePose({id, time, level: .18, active: true});
      assert.ok(Math.abs(pose.tilt) <= 2.8 && Math.abs(pose.nod) <= 3.2);
      assert.ok(pose.scale >= 1 && pose.scale <= 1.04);
      const next = presencePose(id, time + 1 / 24, .4);
      const current = presencePose(id, time, .4);
      assert.ok(Math.abs(next.tilt - current.tilt) < .1 && Math.abs(next.nod - current.nod) < .25);
    }
    const off = voiceMessagePose({id,time:4,level:1,active:false});
    assert.equal(off.mouth,0); assert.equal(off.tilt,0); assert.equal(off.blink,0);
    assert.equal(voiceMessagePose({id,time:4,level:0,active:true}).viseme,0);
    assert.deepEqual(presencePose(id, 4, .4), presencePose(id, 4, .4));
  }
  assert.equal(signatures.size, 4);
});

test('every prepared character has a valid square PNG atlas on the registered grid', () => {
  for (const name of ['KIANA','DELLA','LILLY','HARLEY']) {
    const {sheet} = portraits.preparedPortrait(portraits[name+'_ID'],portraits[name+'_PORTRAIT_FILE']);
    const png = readFileSync(new URL('../../../../public' + sheet.nuance, import.meta.url));
    assert.equal(png.subarray(1,4).toString(),'PNG');
    assert.equal(png.readUInt32BE(16),1254);
    assert.equal(png.readUInt32BE(20),1254);
    const end = panelRect(8);
    assert.ok(end[0]+end[2] <= 1.00001);
  }
});
