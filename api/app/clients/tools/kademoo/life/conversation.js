const { residentReply } = require('@librechat/api');
const { register } = require('./registry');
const { MooChar, MooDistrict, matchName, setAttrs } = require('./ctx');
const reverie = require('../reverie');

register({
  name: 'converse',
  aliases: ['reply'],
  free: true,
  help: {
    topic: 'people',
    usage: 'converse Pat: How was your morning? · reply <your words> · end conversation',
    blurb:
      'Talk naturally with somebody here. Reply continues with the same person. Recent exchanges are remembered privately for your character.',
  },
  async run(ctx, { argRaw, verbName }) {
    const split = verbName === 'reply' ? -1 : argRaw.indexOf(':');
    const query = split >= 0 ? argRaw.slice(0, split).trim() : '';
    const text = (split >= 0 ? argRaw.slice(split + 1) : argRaw).trim();
    const people = await MooChar.find({ roomId: ctx.ch.roomId, userId: /^npc:/ }).lean();
    const person = query
      ? matchName(people, query)
      : people.find((p) => p.userId === ctx.life.conversationWith);
    if (!person)
      return ctx.fail(
        'Choose somebody who is here: converse Name: your words. Tap a person’s name for conversation choices.',
      );
    if (!text) return ctx.fail(`Type converse ${person.name}: followed by what you want to say.`);
    if (text.length > 600)
      return ctx.fail('Keep each turn to 600 characters or fewer so there is room for an answer.');
    const now = Date.now();
    const lock = await MooChar.updateOne(
      {
        _id: ctx.ch._id,
        $or: [
          { 'attrs.life.conversationBusyUntil': { $exists: false } },
          { 'attrs.life.conversationBusyUntil': { $lte: now } },
        ],
      },
      { $set: { 'attrs.life.conversationBusyUntil': now + 25000 } },
    );
    if (!lock.modifiedCount) return ctx.fail('Give them a moment to answer before speaking again.');
    const key = person.userId.replace(/^npc:/, '');
    const history = ctx.life.conversations?.[key] || [];
    let answer = null;
    try {
      if (process.env.REFRAME_PROXY_SECRET) {
        await MooDistrict.updateOne(
          { districtId: 'reverie_conversation_budget_153' },
          {
            $setOnInsert: {
              name: 'Resident conversation allowance',
              props: { calls: 0, limit: 100, reservedPerCallUSD: 0.01 },
            },
          },
          { upsert: true },
        );
        const reservation = await MooDistrict.updateOne(
          { districtId: 'reverie_conversation_budget_153', 'props.calls': { $lt: 100 } },
          { $inc: { 'props.calls': 1 } },
        );
        if (reservation.modifiedCount)
          answer = await residentReply({
            name: person.name,
            character: JSON.stringify({
              description: person.attrs?.desc,
              canon: reverie.CENSUS_BY_ID?.[person.userId] || reverie.CENSUS_BY_ID?.[key],
            }).slice(0, 2200),
            place: (await ctx.room()).name,
            weather: reverie.weatherNow().line,
            doing: reverie.npcDoingNow(person.userId)?.doing || '',
            player: ctx.ch.name,
            message: text,
            history,
          });
      }
      if (!answer) {
        ctx.say(
          `${person.name} cannot answer freely right now. You can still use Talk to for their usual conversation.`,
        );
        return ctx.ok({
          choices: [{ label: `Talk to ${person.name}`, cmd: `talk to ${person.name}` }],
        });
      }
      if (!(await MooChar.exists({ _id: ctx.ch._id, active: true, roomId: ctx.ch.roomId }))) {
        return ctx.fail('You have moved on. Start a conversation with somebody where you are now.');
      }
      await setAttrs(ctx.ch, {
        'life.conversationWith': person.userId,
        [`life.conversations.${key}`]: [
          ...history,
          { role: 'user', content: text },
          { role: 'assistant', content: answer },
        ].slice(-6),
      });
      ctx
        .say(`You say to ${person.name}, “${text}”`, `${person.name}: ${answer}`)
        .need({ company: 3 });
      return ctx.ok({
        conversation: { name: person.name, prefix: 'reply ' },
        choices: [
          { label: `Reply to ${person.name}`, cmd: 'reply ', compose: true },
          { label: 'End conversation', cmd: 'end conversation' },
        ],
      });
    } finally {
      await setAttrs(ctx.ch, { 'life.conversationBusyUntil': 0 });
    }
  },
});
register({
  name: 'end conversation',
  free: true,
  help: {
    topic: 'people',
    usage: 'end conversation',
    blurb: 'Finish talking and return to exploring.',
  },
  async run(ctx) {
    await setAttrs(ctx.ch, { 'life.conversationWith': null });
    return ctx.ok({ lines: [...ctx.lines, 'You finish the conversation.'], conversation: null });
  },
});
