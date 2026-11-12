/* WEB-13 (Nov 12 2026): the call screen's 75 s stall watchdog must count only real `data:` lines.
 * The server now writes a ': ping' comment every 20 s while a reply stream is open; if any byte
 * reset the watchdog, a hung turn would sit on "thinking" until the 20-minute job reaper.
 *
 * The read loop lives deep inside ConversationMode, so this checks it two ways: the source
 * shape (where lastByteAtRef is set), and the loop's own line handling run against a byte stream
 * of pings with the real code cut out of the file.
 * Run: node --test client/src/components/Chat/ConversationMode.stall.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ConversationMode.tsx', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
);
const loopStart = source.indexOf('        streamLoop: while (true) {');
const loopEnd = source.indexOf('            const payload = line.slice(5).trim();', loopStart);
const loop = source.slice(loopStart, loopEnd);

test('the stall clock is set once when the stream opens and then only after a data: check', () => {
  assert.ok(loopStart > 0 && loopEnd > loopStart, 'read loop found');
  const sets = source.match(/lastByteAtRef\.current = Date\.now\(\);/g) ?? [];
  assert.equal(sets.length, 2, 'one set at stream open, one per data line');
  const readAt = loop.indexOf('await reader.read()');
  const dataCheckAt = loop.indexOf("if (!line.startsWith('data:')) continue;");
  const setAt = loop.indexOf('lastByteAtRef.current = Date.now();');
  assert.ok(readAt > 0 && dataCheckAt > readAt, 'data check inside the loop');
  assert.ok(setAt > dataCheckAt, 'the clock is reset only after a line passed the data: check');
});

test('a stream of heartbeat pings never resets the clock; a data line does', () => {
  // The per-line body of the loop, up to the payload parse, run on its own.
  const body = loop.slice(loop.indexOf('          for (const rawLine of lines) {'));
  const runLines = new Function(
    'lines',
    'lastByteAtRef',
    `let curEvent = 'message';\n${body}\n}\nreturn curEvent;`,
  );
  const ref = { current: 0 };
  const realNow = Date.now;
  try {
    Date.now = () => 1000;
    runLines([': ping', '', ': ping', ''], ref);
    assert.equal(ref.current, 0, 'pings and blank lines leave the clock alone');
    runLines(['event: message'], ref);
    assert.equal(ref.current, 0, 'an event: line alone is not data');
    runLines(['data: {"sync":true}'], ref);
    assert.equal(ref.current, 1000, 'a data line resets it');
  } finally {
    Date.now = realNow;
  }
});
