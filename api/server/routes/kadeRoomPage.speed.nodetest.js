'use strict';
/* Oct 30 2026: read-aloud speed in the Debate Room. The listener's number beats a character's, and
 * a character's number applies only to its own builder voice, not to a voice picked from a name.
 * Run: node --test api/server/routes/kadeRoomPage.speed.nodetest.js */
const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { roomHtml } = require('./kadeRoomPage');

/* The real functions from the page, on small stand-ins for the browser. */
const source = roomHtml.slice(
  roomHtml.indexOf('async function voiceFor(ag){'),
  roomHtml.indexOf('async function oneTurn(){'),
);

const spokenWith = async ({ member, saved }) => {
  const sent = [];
  const page = vm.runInNewContext(
    `var token = 't', readAloud = true, speakQ = [], speaking = false, audioEl = null,
         voicesList = null, room = { agents: [member] };
     ${source}
     ({ say: function () { speakLine({ speaker: member.agentId, text: 'A line.' }); },
        done: function () { return !speaking && !speakQ.length; } });`,
    {
      member: { agentId: 'agent_1', name: 'Ann', ...member },
      FormData,
      JSON,
      isFinite,
      setTimeout,
      console,
      localStorage: {
        getItem: (key) => {
          if (saved instanceof Error) {
            throw saved;
          }
          return key === 'voicePacePreference' && saved !== undefined ? saved : null;
        },
      },
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
      Audio: function Audio() {
        this.play = () => {
          setTimeout(() => this.onended());
          return Promise.resolve();
        };
      },
      fetch: async (url, init) => {
        if (url === '/api/files/speech/tts/voices') {
          return { json: async () => ['Fallback voice'] };
        }
        sent.push({ voice: init.body.get('voice'), speed: init.body.get('speed') });
        return { ok: true, blob: async () => ({}) };
      },
    },
  );
  page.say();
  while (!page.done()) {
    await new Promise(setImmediate);
  }
  assert.strictEqual(sent.length, 1);
  return sent[0];
};

const builder = { voiceId: 'Builder voice', rate: 1.2 };
const fallback = { voiceId: '', rate: 1.2 };

test("a character's number plays on its own builder voice", async () => {
  assert.deepStrictEqual(await spokenWith({ member: builder }), {
    voice: 'Builder voice',
    speed: '1.2',
  });
});

test("the listener's number beats the character's", async () => {
  assert.deepStrictEqual(await spokenWith({ member: builder, saved: '1.4' }), {
    voice: 'Builder voice',
    speed: '1.4',
  });
});

test("the listener's 1x is a real choice, not an empty one", async () => {
  assert.strictEqual((await spokenWith({ member: builder, saved: '1' })).speed, '1');
});

test("a voice picked from the name never gets the character's number", async () => {
  assert.deepStrictEqual(await spokenWith({ member: fallback }), {
    voice: 'Fallback voice',
    speed: null,
  });
});

test("a voice picked from the name still gets the listener's number", async () => {
  assert.deepStrictEqual(await spokenWith({ member: fallback, saved: '0.8' }), {
    voice: 'Fallback voice',
    speed: '0.8',
  });
});

test('a character with no number and no listener number sends no speed', async () => {
  assert.strictEqual((await spokenWith({ member: { voiceId: 'Builder voice' } })).speed, null);
});

test('"Character\'s speed" (saved as null) leaves the character\'s number in charge', async () => {
  assert.strictEqual((await spokenWith({ member: builder, saved: 'null' })).speed, '1.2');
});

test('a saved value that is not a number, or blocked storage, changes nothing', async () => {
  for (const saved of ['fast', '"1.4"', new Error('blocked')]) {
    assert.strictEqual((await spokenWith({ member: builder, saved })).speed, '1.2');
  }
});
