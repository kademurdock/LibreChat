const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { KadeCallTranscript, logKadeCall } = require('./kadeCallTranscript');

test('logKadeCall persists allowlisted surfaces and defaults unknown ones', async (t) => {
  const mongoServer = await MongoMemoryServer.create();
  try {
    await mongoose.connect(mongoServer.getUri());
    for (const [surface, expected] of [
      ['phone', 'phone'],
      ['web', 'web'],
      ['conversation', 'conversation'],
      ['unknown', 'conversation'],
      [undefined, 'conversation'],
    ]) {
      await t.test(`${surface} becomes ${expected}`, async () => {
        const id = await logKadeCall({
          userId: new mongoose.Types.ObjectId().toString(),
          surface,
          turns: [{ role: 'user', text: 'Hello' }],
        });

        assert.ok(id);
        const saved = await KadeCallTranscript.findById(id).lean();
        assert.equal(saved.surface, expected);
      });
    }
  } finally {
    await mongoose.disconnect();
    await mongoServer.stop();
  }
});
