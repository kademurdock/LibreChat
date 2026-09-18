const { register } = require('./registry');
const { reverieWardrobe } = require('@librechat/api');

register({
  name: 'wardrobe',
  aliases: ['change my look'],
  free: true,
  help: {
    topic: 'you',
    usage: 'wardrobe · hair pink curls · wear a blue dress and headphones',
    blurb: 'Change your own hair or clothes for free. Choose a button, type, or dictate.',
  },
  buttons: () => [{ label: 'Change my look', cmd: 'wardrobe', group: 'self' }],
  async run(ctx) {
    ctx.say(
      'Choose hair or clothes. You can also dictate hair followed by your own description, or wear followed by your outfit. Changes are free and keep everything you own.',
    );
    return ctx.ok({
      choices: [
        { label: 'Hair', cmd: 'hair' },
        { label: 'Clothes', cmd: 'wear' },
      ],
    });
  },
});
for (const [name, field, options] of [
  [
    'hair',
    'hair',
    [
      'pink curls',
      'purple locs',
      'blue short hair',
      'long blonde hair',
      'gray curls',
      'dark hair in a bun',
      'shaved hair',
    ],
  ],
  [
    'wear',
    'style',
    [
      'a blue dress and sneakers',
      'a green hoodie and headphones',
      'a red coat and boots',
      'purple coveralls',
      'a yellow shirt and jeans',
    ],
  ],
])
  register({
    name,
    free: true,
    pattern: name === 'hair' ? /^(pink|purple|blue|red|blonde|gray|silver) hair[.!]?$/i : undefined,
    help: {
      topic: 'you',
      usage: `${name} <your description>`,
      blurb: `Choose your own ${field === 'hair' ? 'hair' : 'clothes'}.`,
    },
    async run(ctx, { argRaw, match }) {
      if (!argRaw)
        return ctx.ok({
          lines: [
            ...ctx.lines,
            `Choose ${field === 'hair' ? 'hair' : 'an outfit'}, or dictate your own description after ${name}.`,
          ],
          choices: options.map((value) => ({ label: value, cmd: `${name} ${value}` })),
        });
      const changed = reverieWardrobe(field, match ? `${match[1].toLowerCase()} hair` : argRaw);
      if (!changed.ok) return ctx.fail(changed.line);
      await ctx.setAttrs(ctx.ch, { [`life.look.${field}`]: changed.value });
      const look = ctx.ch.attrs.life.look;
      const line = [look.build, look.hair, look.style].filter(Boolean).join(', ');
      await ctx.setAttrs(ctx.ch, { 'life.look.line': line, desc: line });
      await ctx.emit(
        ctx.ch.roomId,
        ctx.userId,
        ctx.ch.name,
        'emote',
        `${ctx.ch.name} changes their ${field === 'hair' ? 'hair' : 'outfit'}: ${changed.value}.`,
      );
      ctx.say(changed.line);
      return ctx.ok({ wantRoom: true });
    },
  });
