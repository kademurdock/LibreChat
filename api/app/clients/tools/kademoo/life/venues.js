/* REVERIE LIFE — five new places to go (Part 296, Sep 26 2026).
 *
 * Kade's ask: "more places, rooms, more sounds, whatever you need to make it
 * an accessible version of the Sims that a visual person will still have fun
 * and want to play." The Sims has always been as much about where you go as
 * what you own, and the city had nowhere to see a picture, play a machine,
 * swim indoors, buy bread or paint. Each place below has a keeper in the
 * census (reverie.js), its own smell, ear-line, footing and ambience, a job,
 * and things to do that pay off in fun, skill, keepsakes and satisfaction:
 *
 *   the Bijou                 Tanglefoot, northeast off Line Street
 *                             a real bill of three pictures that changes daily
 *   the Starlite Arcade       Millrace, southeast off the Millrace
 *                             pinball, skee-ball, the claw, tickets and prizes
 *   the Early Bird Bakery     the Patch, northwest off Gully Road
 *                             warm food and baking you can carry and give away
 *   the Sweetwater Bathhouse  Sweetwater, southwest off the park
 *                             laps, cannonballs, sauna and the hot tub
 *   the Easel                 Fairlawn, northwest off Fairlawn Avenue
 *                             paint anything in your own words; hang it, sell
 *                             it, or buy what other people painted
 *
 * Everything is authored and decided in code. No model call anywhere. The
 * rooms are insert-if-absent and each street link is patched only if that
 * direction is still free, the same rule the carve has always kept. */
const registry = require('./registry');
const {
  MooRoom, MooChar, MooItem, emit, setAttrs, setBusy, payCoin, earnCoin, coinOf, makeItem, worldClock,
  hashStr, pick, cap, joinAnd, plural, matchName, logger,
} = require('./ctx');
const { MooBoard } = require('~/models/kadeMooLife');

/* ── THE ROOMS ─────────────────────────────────────────────────────────── */
const VENUES = [
  {
    roomId: 'the_bijou', name: 'the Bijou', district: 'tanglefoot',
    desc: 'Popcorn butter and old velvet. A projector ticks somewhere above and behind you, steady as a clock. Rows of red seats slope down toward a screen with gold curtains, and most of the seats still spring back up. Flo Abernathy sells tickets from a glass booth by the door and runs the projector herself. Tonight’s bill is chalked on a board in the lobby. Line Street is back out the southwest door.',
    exits: { sw: 'tanglefoot_line_street' },
    link: { from: 'tanglefoot_line_street', dir: 'ne' },
    props: {
      smell: 'Popcorn butter, velvet that has seen things, and the warm dust smell of a projector bulb.',
      listenLine: 'The projector ticks behind the wall. Seats creak and fold. Somebody laughs a half second before everybody else.',
      doings: 'See a picture: "watch a movie" reads tonight’s bill. Buy popcorn ("eat"). Take somebody on a date; the back row is a tradition. Work the booth.',
      surface: 'carpet', sound: 'amb.bijou.room', scene: 'theater', indoor: true,
      food: { menu: 'a paper bag of popcorn with real butter and a box of candy you will regret', price: 3 },
      job: { name: 'the Bijou booth', wage: 7, line: 'You tear tickets, sweep the aisles between shows, and change the reel when Flo nods at you. She lets you watch the last ten minutes from the booth.', refusal: 'Flo waves you off with a ticket stub. "Go see a picture instead. You have earned one."' },
    },
  },
  {
    roomId: 'starlite_arcade', name: 'the Starlite Arcade', district: 'millrace',
    desc: 'Bells, flippers, and the rumble of a skee-ball rolling up its ramp. The carpet is dark blue with little planets on it, worn pale down the middle. Pinball machines stand along one wall with their back glasses lit orange and green. The claw machine waits by the door, full of plush animals. Tickets spill out of the skee-ball lanes and pile up on the floor. Teddy Okafor keeps the prize counter and a screwdriver in his shirt pocket. The Millrace is back out the northwest door.',
    exits: { nw: 'millrace_channel' },
    link: { from: 'millrace_channel', dir: 'se' },
    props: {
      smell: 'Warm electronics, carpet shampoo, and spun sugar from the cotton candy machine by the prize counter.',
      listenLine: 'Flippers clack. A pinball rattles through the bumpers and a bell rings. Skee-balls thud up the ramps and drop into the rings.',
      doings: 'Play pinball ("play pinball", or "play pinball careful" or "wild"), roll skee-ball, try the claw machine, and trade tickets at the prize counter ("prizes"). "scores pinball" and "scores skeeball" for the boards.',
      surface: 'carpet', sound: 'amb.arcade.room', scene: 'arcade', indoor: true,
      food: { menu: 'a cloud of cotton candy and a cold soda from the cooler', price: 2 },
      job: { name: 'the Starlite prize counter', wage: 6, line: 'You count tickets, restock the claw machine, and pry a stuck quarter loose with Teddy’s screwdriver. He lets you play one free game at close.', refusal: 'Teddy shakes his head. "You have counted enough tickets for one day. Go win some."' },
    },
  },
  {
    roomId: 'early_bird_bakery', name: 'the Early Bird Bakery', district: 'patch',
    desc: 'Warm bread first, then cinnamon, then coffee. A bell over the door rings every time it opens, which is often. Glass cases hold rolls, pies and fat cinnamon buns. Behind the counter the oven door groans open and shut, and Roz Quintero moves between it and the register like she has done it ten thousand times. A chalkboard says what came out of the oven last. Gully Road is back out the southeast door.',
    exits: { se: 'patch_gully_road' },
    link: { from: 'patch_gully_road', dir: 'nw' },
    props: {
      smell: 'Bread crust, cinnamon, and flour so fine it hangs in the air.',
      listenLine: 'The oven door groans. A tray slides onto a rack. The bell over the door rings, and Roz calls hello without looking up.',
      doings: 'Buy something warm ("eat"). Bake something to take with you or give away ("bake"). Work the ovens before dawn ("work").',
      surface: 'linoleum', sound: 'amb.bakery.room', scene: 'bakery', indoor: true,
      food: { menu: 'a warm cinnamon bun, a buttered roll, and coffee better than Pat’s (do not tell Pat)', price: 2 },
      job: { name: 'the bakery ovens', wage: 7, line: 'You shape dough, load the trays, and pull the bread when Roz says, not a second before. Your arms are floured to the elbow. She sends you off with a day-old loaf.', refusal: 'Roz points at the door with a floury finger. "Bread needs a rest. So do you. Tomorrow, early."' },
    },
  },
  {
    roomId: 'sweetwater_bathhouse', name: 'the Sweetwater Bathhouse', district: 'sweetwater',
    desc: 'Warm wet air and the echo of water under a high tile roof. A long pool runs down the middle, blue-green and lit from below, and the lane ropes knock softly against each other. Steam leaks out around the cedar door of the sauna. A hot tub bubbles in the corner. Mabel Oyelaran watches from a tall lifeguard chair with a whistle she has used twice in eleven years. The park is back out the northeast door.',
    exits: { ne: 'sweetwater_park' },
    link: { from: 'sweetwater_park', dir: 'sw' },
    props: {
      smell: 'Chlorine, cedar steam from the sauna, and the clean towel smell of the linen shelf.',
      listenLine: 'Water laps at the pool edge and echoes off the tile. Lane ropes knock. The sauna stones hiss when somebody ladles water over them.',
      doings: 'Swim laps, cannonball into the deep end, sweat in the sauna, soak in the hot tub. Towels are free. Mabel insists on a shower first.',
      surface: 'linoleum', sound: 'amb.bathhouse.pool', scene: 'pool', indoor: true, water: 'pool',
      job: { name: 'the bathhouse towels', wage: 6, line: 'You fold towels, hose down the deck, and blow the whistle once, at a boy running. Mabel nods. That nod is worth more than the pay.', refusal: 'Mabel points at the pool. "You are off the clock. Swim."' },
    },
  },
  {
    roomId: 'the_easel', name: 'the Easel', district: 'fairlawn',
    desc: 'Turpentine and coffee. Tall north windows pour even light over a dozen easels, a long table crusted with dried paint, and jars of brushes standing on their handles. The back wall is the gallery: framed paintings hung close together, each with a small card saying who made it and what it costs. Anselm Ruiz paints by the window and argues with his canvas when it misbehaves. Fairlawn Avenue is back out the southeast door.',
    exits: { se: 'fairlawn_ave' },
    link: { from: 'fairlawn_ave', dir: 'nw' },
    props: {
      smell: 'Turpentine, linseed oil, and burnt coffee from a pot nobody is watching.',
      listenLine: 'Brushes tap the rims of water jars. Charcoal scratches paper. Anselm hums, stops, and argues quietly with a painting.',
      doings: 'Paint anything you like: "paint <what you want to paint>". "sketch" to practice. "gallery" to see what people have made. Sell your paintings to the gallery, buy other people’s, or hang yours at home.',
      surface: 'wood.interior', sound: 'amb.easel.room', scene: 'studio', indoor: true,
      job: { name: 'the Easel studio', wage: 6, line: 'You stretch canvas, wash brushes, and sweep up charcoal dust. Anselm shows you a trick with a palette knife and makes you promise not to say where you learned it.', refusal: 'Anselm waves a brush at you. "Go paint something of your own. That is the job now."' },
    },
  },
];
const VENUE_BY_ID = Object.fromEntries(VENUES.map((v) => [v.roomId, v]));

async function seed() {
  for (const v of VENUES) {
    const { link, ...room } = v;
    await MooRoom.updateOne({ roomId: v.roomId }, { $setOnInsert: { ...room, createdBy: 'reverie_seed' } }, { upsert: true });
    if (link) {
      const done = await MooRoom.updateOne({ roomId: link.from, [`exits.${link.dir}`]: { $exists: false } }, { $set: { [`exits.${link.dir}`]: v.roomId } });
      if (!done.modifiedCount) {
        const street = await MooRoom.findOne({ roomId: link.from }).select('exits').lean();
        if (street && street.exits && street.exits[link.dir] !== v.roomId) logger.warn(`[reverie] ${v.roomId}: ${link.from} ${link.dir} is taken; reachable by "go to" only`);
      }
    }
  }
}

const here = (id) => (ctx) => ctx.ch.roomId === id;
const btn = (id, label, cmd) => (ctx) => (ctx.ch.roomId === id ? [{ label, cmd, group: 'here' }] : []);
const level = (ctx, k) => require('./skills').levelOf((ctx.life.skills || {})[k] || 0);
async function others(ctx) {
  return MooChar.find({ roomId: ctx.ch.roomId, userId: { $ne: ctx.userId, $not: /^(stray|pet):/ } }).select('name attrs.aka').lean();
}
/** What you would call somebody across a room: their short name if they go by one. */
function firstName(p) {
  if (p && typeof p === 'object') return (p.attrs && p.attrs.aka) || String(p.name || '').split(' ')[0];
  return String(p || '').split(' ')[0];
}
async function cooldown(ctx, key, ms) {
  const now = Date.now();
  const path = `attrs.life.cool.${key}`;
  const res = await MooChar.updateOne({ _id: ctx.ch._id, $or: [{ [path]: { $exists: false } }, { [path]: { $lte: now - ms } }] }, { $set: { [path]: now } });
  return res.modifiedCount > 0;
}

/* ── THE BIJOU: a bill of three pictures a day ─────────────────────────── */
const FILMS = [
  { title: 'The Last Ferry to Sweetwater', genre: 'romance', minutes: 104, logline: 'Two strangers miss the last crossing and have to wait out the night on the dock.', moment: 'Around the middle, one of them lends the other a coat, and the whole theater goes quiet in a good way.', ending: 'The morning ferry comes. Only one of them gets on. The lights come up on a lot of people pretending to have something in their eye.' },
  { title: 'The Thing Under Pier Seven', genre: 'monster', minutes: 88, logline: 'Something big is eating the bait off every line in the harbor, and nobody believes the kid who saw it.', moment: 'When the rubber tentacle comes up out of the water, somebody in row three screams, then laughs at themselves for screaming.', ending: 'It turns out to be very large and very lonely. The kid feeds it sandwiches. Everybody claps.' },
  { title: 'Two Dollars and a Dream', genre: 'comedy', minutes: 92, logline: 'A man bets his last two dollars on a turtle race and accidentally wins a bowling alley.', moment: 'The turtle refuses to cross the line until somebody plays it a harmonica. The theater loses it.', ending: 'He keeps the bowling alley. The turtle gets its own lane. You laugh on the walk out.' },
  { title: 'The Marshal of Long Acre', genre: 'western', minutes: 115, logline: 'A tired marshal has one day to get a stolen herd back before the freight train takes the evidence out of the county.', moment: 'There is a long, silent stare-down in the rain, and you can hear the whole room holding its breath.', ending: 'Nobody fires a shot. The marshal just talks, slow and plain, until the thief gives up. The horses go home.' },
  { title: 'Rocket Girls of the Dust Planet', genre: 'space adventure', minutes: 99, logline: 'Three sisters fix a broken rocket with parts from a junkyard and fly it farther than anybody said they could.', moment: 'The launch shakes the seats. Flo turned the sound up for it, you are sure of it.', ending: 'They land on a planet made of dust and wind and plant a flag made from their mother’s apron.' },
  { title: 'The Case of the Wrong Bell', genre: 'mystery', minutes: 97, logline: 'A town clock rings thirteen, a banker vanishes, and a retired librarian is the only one who notices the pattern.', moment: 'The librarian finds the clue in a returned book, and someone near you whispers "I knew it."', ending: 'The banker was hiding in the bell tower the whole time, keeping the clock wrong on purpose. The librarian is not surprised.' },
  { title: 'Everybody Sing', genre: 'musical', minutes: 108, logline: 'A laundromat, a bus depot and a hardware store put on one show together to save their block.', moment: 'In the big number the washing machines keep the beat, and a few people in the audience sing along under their breath.', ending: 'The block is saved. The last song is so catchy it follows you out onto the street.' },
  { title: 'Biscuit Goes to Town', genre: 'cartoon', minutes: 71, logline: 'A gray cat named Biscuit rides a milk truck into the big city and tries to find her way home.', moment: 'Biscuit gets stuck in a revolving door for what feels like a full minute. The kids in the front row cannot breathe from laughing.', ending: 'She finds her way home by following the smell of her own back porch. Everybody wants a cat now.' },
  { title: 'Frost on the Orchard', genre: 'drama', minutes: 121, logline: 'A family orchard has one cold night to save the whole year’s apples, and the family has not talked in a decade.', moment: 'They light smudge pots all night, row by row, and start talking without meaning to.', ending: 'Half the crop survives. All of the family does. It is the kind of ending that sits with you.' },
  { title: 'The Great Pie Heist', genre: 'comedy', minutes: 90, logline: 'Four retirees plan to steal the prize pie from the county fair, and every plan goes wrong in a new way.', moment: 'The getaway car is a riding lawn mower. The theater claps when it starts.', ending: 'They get caught, share the pie with the judge, and win a ribbon for teamwork.' },
  { title: 'Moonlight Over the Millrace', genre: 'romance', minutes: 101, logline: 'A mechanic and a piano teacher keep running into each other at the same broken-down bus stop.', moment: 'He fixes the bus. She plays the bus horn like a piano. It should be silly and somehow it is not.', ending: 'They take the bus together to the end of the line, and the camera stays on the empty stop.' },
  { title: 'Attack of the Fifty-Foot Heron', genre: 'monster', minutes: 84, logline: 'A science fair project goes wrong and a heron grows as tall as a water tower.', moment: 'The heron swallows a whole city bus, very carefully, and puts it back.', ending: 'The heron just wanted fish. The town builds it a very big pond. The kids cheer.' },
  { title: 'The Long Drive Home', genre: 'road drama', minutes: 112, logline: 'A father and his grown son drive a truck full of furniture across three states without talking about the one thing.', moment: 'They finally stop at a diner at two in the morning and the son orders for both of them without asking. That is the whole conversation, and it is enough.', ending: 'They get the furniture home. The last shot is two coffee cups on a dashboard.' },
  { title: 'Detective Juniper and the Missing Page', genre: 'kids mystery', minutes: 78, logline: 'A ten-year-old detective has one afternoon to find the last page of the library’s oldest book.', moment: 'Juniper interviews a very suspicious parrot, and the parrot repeats everything back at the worst times.', ending: 'The page was a bookmark in the librarian’s own lunch bag. Everybody laughs, including the librarian.' },
  { title: 'Saturn Station', genre: 'space thriller', minutes: 106, logline: 'The last cook on a space station has to land it when everybody else is asleep.', moment: 'He flies the whole station using a recipe card for timing. It works better than it should.', ending: 'He lands it, makes breakfast, and nobody ever believes him.' },
  { title: 'Dance Hall Days', genre: 'musical', minutes: 110, logline: 'An old dance hall gets one last Saturday night before it becomes a parking lot.', moment: 'Every couple who ever met there comes back for the last waltz, and they fill the floor.', ending: 'The dance hall stays. The parking lot goes somewhere else. The band plays you out.' },
  { title: 'Blackout on Bell Street', genre: 'thriller', minutes: 94, logline: 'The power goes out across the whole city, and a night nurse is the only one who knows why.', moment: 'The only light for five minutes is one flashlight, and the whole theater leans forward.', ending: 'She gets the lights back on at dawn and goes home to sleep. Nobody thanks her in the film. You want to.' },
  { title: 'A Raccoon Named Senator', genre: 'cartoon', minutes: 74, logline: 'A raccoon accidentally gets elected to the town council and turns out to be good at it.', moment: 'The Senator holds a meeting in a trash can and it is the most productive meeting in town history.', ending: 'He passes one law: more trash cans. Everybody votes yes.' },
];
function billFor(dayKey) {
  const out = [];
  let i = 0;
  while (out.length < 3 && i < 40) {
    const f = FILMS[hashStr(`${dayKey}|bill|${i++}`) % FILMS.length];
    if (!out.includes(f)) out.push(f);
  }
  return out;
}
function billLine(bill) {
  return `Tonight at the Bijou: ${bill.map((f, i) => `${i + 1}. ${f.title}, a ${f.genre}, ${f.minutes} minutes`).join('; ')}.`;
}

registry.register({
  name: 'watch a movie', aliases: ['watch movie', 'see a movie', 'watch a picture', 'see a picture', 'movies', 'movie', 'showtimes', 'the bill', 'watch a film', 'see a film'],
  help: { topic: 'fun', usage: 'watch a movie · watch a movie 2', blurb: 'See a picture at the Bijou in Tanglefoot. Three on the bill, a new bill every day.' },
  async run(ctx, { arg }) {
    const bill = billFor(worldClock().dayKey);
    if (ctx.ch.roomId !== 'the_bijou') {
      ctx.say(`${billLine(bill)} The Bijou is in Tanglefoot, off Line Street.`);
      return ctx.ok({ choices: [{ label: 'Go to the Bijou', cmd: 'go to the_bijou' }] });
    }
    const a = String(arg || '').trim().toLowerCase();
    const film = /^[1-3]$/.test(a) ? bill[Number(a) - 1] : a ? bill.find((f) => f.title.toLowerCase().includes(a)) : null;
    if (!film) {
      ctx.say(`${billLine(bill)} A ticket is ${ctx.isChild ? '$2 for you' : '$4'}.`);
      return ctx.ok({ choices: bill.map((f, i) => ({ label: `${f.title} (${f.genre})`, cmd: `watch a movie ${i + 1}` })) });
    }
    const price = ctx.isChild ? 2 : 4;
    if (!(await payCoin(ctx.ch, price))) return ctx.fail(`A ticket is $${price}. You carry $${coinOf(ctx.ch)}. Flo has heard every story; none of them are tickets.`);
    const company = await others(ctx);
    await setBusy(ctx.ch, 20, 'watching a picture');
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} buys a ticket for ${film.title} and finds a seat as the lights go down.`, 'cer.bijou.projector');
    const games = { ...(ctx.life.games || {}), movies: ((ctx.life.games || {}).movies || 0) + 1 };
    ctx.life.games = games;
    await setAttrs(ctx.ch, { 'life.games': games });
    ctx.need({ fun: 30, rested: 5, company: company.length ? 8 : 2 });
    ctx.say(`The lights go down. ${film.title}. ${film.logline} ${film.moment} ${film.ending}`);
    if (company.length) ctx.say(`${joinAnd(company.slice(0, 3).map((p) => firstName(p)))} ${company.length === 1 ? 'was' : 'were'} somewhere in the dark with you.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'cer.bijou.projector'] });
  },
  buttons: btn('the_bijou', 'Watch a movie', 'watch a movie'),
});

/* ── THE STARLITE ARCADE ───────────────────────────────────────────────── */
async function board(name, ctx, score, note) {
  await MooBoard.create({ board: name, userId: ctx.userId, name: ctx.ch.name, score, note: note || '' });
  const top = await MooBoard.find({ board: name }).sort({ score: -1 }).limit(1).lean();
  return top[0] && top[0].userId === ctx.userId && top[0].score === score;
}
async function addTickets(ctx, n) {
  if (n <= 0) return 0;
  await setAttrs(ctx.ch, {}, { 'life.tickets': n });
  ctx.life.tickets = (ctx.life.tickets || 0) + n;
  return n;
}
function commas(n) { return Number(n).toLocaleString('en-US'); }

registry.register({
  name: 'play pinball', aliases: ['pinball', 'play the pinball machine'],
  help: { topic: 'fun', usage: 'play pinball · play pinball careful · play pinball wild', blurb: 'A dollar a game at the Starlite Arcade. Careful plays it safe; wild swings for the jackpot and risks a tilt.' },
  when: here('starlite_arcade'),
  whyNot: () => 'The pinball machines are at the Starlite Arcade, off the Millrace.',
  async run(ctx, { arg }) {
    const style = /wild|big|jackpot|risk/.test(arg || '') ? 'wild' : /careful|safe|steady/.test(arg || '') ? 'careful' : 'normal';
    if (!(await payCoin(ctx.ch, 1))) return ctx.fail('A game is a dollar in quarters, and you are out of dollars.');
    const played = (ctx.life.games && ctx.life.games.pinball) || 0;
    const skill = level(ctx, 'hustle') * 0.6 + Math.min(played, 40) / 10;
    const mult = style === 'wild' ? 1.6 : style === 'careful' ? 0.8 : 1;
    const moves = ['trap the ball on the left flipper and shoot the orbit', 'light all three Comet targets', 'send it up the ramp twice in a row', 'rattle it through the pop bumpers', 'hit the spinner so hard it whines', 'catch it on the right flipper at the last second', 'lock a ball and start multiball', 'nudge the table just enough to save a drain'];
    const drains = ['It drains straight down the middle.', 'It slips out the left side.', 'It dies in the outlane you swear was not there before.', 'It rolls between the flippers like it has somewhere to be.'];
    let total = 0;
    const lines = [];
    const kinds = ['game.pinball.start'];
    for (let ball = 1; ball <= 3; ball++) {
      const events = 2 + Math.floor(Math.random() * 3) + Math.floor(skill / 2);
      let score = 0;
      for (let e = 0; e < events; e++) score += Math.round((1500 + Math.random() * 6000) * mult);
      const tilt = style === 'wild' && Math.random() < 0.12;
      const jackpot = !tilt && Math.random() < (style === 'wild' ? 0.07 : 0.03) + skill * 0.008;
      if (jackpot) { score += 100000; kinds.push('game.pinball.jackpot'); }
      if (tilt) score = Math.round(score / 3);
      total += score;
      lines.push(`Ball ${ball}: you ${pick(moves)}${jackpot ? ', and the JACKPOT lights ring all at once' : ''}. ${tilt ? 'You shove the table too hard. TILT. The flippers go dead.' : pick(drains)} ${commas(score)}.`);
    }
    kinds.push('game.pinball.bumper', 'game.pinball.drain');
    await setBusy(ctx.ch, 8, 'playing pinball');
    const games = { ...(ctx.life.games || {}), pinball: played + 1 };
    ctx.life.games = games;
    await setAttrs(ctx.ch, { 'life.games': games });
    const top = await board('pinball', ctx, total, style !== 'normal' ? style : '');
    const tickets = await addTickets(ctx, Math.floor(total / 20000) + (top ? 10 : 0));
    ctx.need({ fun: 18, company: 1 });
    ctx.learn('hustle', 2);
    ctx.say(...lines, `Final score: ${commas(total)}.${top ? ' That is the top of the board. Teddy comes over to look and pretends he is not bothered.' : ''} ${tickets ? `The machine spits out ${plural(tickets, 'ticket')}.` : 'No tickets this time.'}`);
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} plays a game of pinball. The bells ring${total > 100000 ? ' like it is a holiday' : ''}.`);
    return ctx.ok({ kinds: [...ctx.kinds, ...kinds, ...(tickets ? ['game.tickets'] : [])] });
  },
  buttons: (ctx) => (ctx.ch.roomId === 'starlite_arcade' ? [{ label: 'Play pinball', cmd: 'play pinball', group: 'here' }, { label: 'Play pinball wild', cmd: 'play pinball wild', group: 'here' }] : []),
});

registry.register({
  name: 'skee ball', aliases: ['skeeball', 'skee-ball', 'play skee ball', 'play skeeball', 'roll skee ball'],
  help: { topic: 'fun', usage: 'skee ball', blurb: 'Nine balls up the ramp for a dollar. Rings pay tickets; the corner hundred pays best.' },
  when: here('starlite_arcade'),
  whyNot: () => 'The skee-ball lanes are at the Starlite Arcade, off the Millrace.',
  async run(ctx) {
    if (!(await payCoin(ctx.ch, 1))) return ctx.fail('A lane is a dollar. You are out of dollars.');
    const played = (ctx.life.games && ctx.life.games.skeeball) || 0;
    const skill = Math.min(1, (level(ctx, 'fitness') * 0.5 + Math.min(played, 30) / 6) / 10);
    const rings = [];
    for (let i = 0; i < 9; i++) {
      const r = Math.random() - skill * 0.35;
      rings.push(r < 0.06 ? 100 : r < 0.18 ? 50 : r < 0.36 ? 40 : r < 0.56 ? 30 : r < 0.8 ? 20 : 10);
    }
    const total = rings.reduce((a, b) => a + b, 0);
    await setBusy(ctx.ch, 6, 'rolling skee-ball');
    const games = { ...(ctx.life.games || {}), skeeball: played + 1 };
    ctx.life.games = games;
    await setAttrs(ctx.ch, { 'life.games': games });
    const top = await board('skeeball', ctx, total);
    const tickets = await addTickets(ctx, Math.floor(total / 30) + (rings.includes(100) ? 5 : 0));
    ctx.need({ fun: 14 });
    ctx.learn('fitness', 1);
    ctx.say(`You roll nine: ${rings.join(', ')}. ${rings.includes(100) ? 'One drops in the corner hundred and the lane lights up. ' : ''}${total} points.${top ? ' Top of the board. Somebody tell Junie Tandy.' : ''} The lane feeds you ${plural(tickets, 'ticket')}.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'game.skeeball.roll', 'game.tickets'] });
  },
  buttons: btn('starlite_arcade', 'Roll skee-ball', 'skee ball'),
});

const PLUSH = ['a plush raccoon in a bow tie', 'a plush gray heron with long felt legs', 'a plush ferry boat with a smiling smokestack', 'a plush orange cat', 'a plush catfish with button whiskers', 'a plush bumblebee', 'a plush bowling pin with a face', 'a plush turtle wearing a crown', 'a plush pink octopus', 'a plush dog with one floppy ear', 'a plush moon with a sleepy face', 'a plush apple from Tandy Orchard', 'a plush rocket ship', 'a plush duck in rain boots', 'a plush owl with glasses', 'a plush piece of pie'];
registry.register({
  name: 'claw machine', aliases: ['claw', 'try the claw', 'play the claw machine', 'play claw'],
  help: { topic: 'fun', usage: 'claw machine', blurb: 'A dollar a try at the Starlite. The claw is not rigged. It is weak. There is a difference.' },
  when: here('starlite_arcade'),
  whyNot: () => 'The claw machine is at the Starlite Arcade, off the Millrace.',
  async run(ctx) {
    if (!(await payCoin(ctx.ch, 1))) return ctx.fail('The claw wants a dollar in quarters. You do not have one.');
    const misses = (ctx.life.clawMisses || 0);
    const chance = Math.min(0.4, 0.1 + level(ctx, 'hustle') * 0.012 + misses * 0.03);
    await setBusy(ctx.ch, 4, 'working the claw');
    ctx.need({ fun: 8 });
    if (Math.random() < chance) {
      const prize = PLUSH[hashStr(`${ctx.userId}|${Date.now()}`) % PLUSH.length];
      await makeItem({ name: prize, desc: `Won from the claw machine at the Starlite Arcade${misses ? ` after ${plural(misses, 'try', 'tries')}` : ' on the first try, which Teddy says has never happened'}. Soft, a little lopsided, and entirely yours.`, location: { type: 'char', id: ctx.userId }, props: { plush: true, giftable: true, gift: 'friend', value: 1 } });
      await setAttrs(ctx.ch, { 'life.clawMisses': 0 });
      ctx.life.clawMisses = 0;
      await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `The claw machine drops ${prize} into the chute for ${ctx.ch.name}. Somebody whoops.`, 'game.claw.win');
      ctx.say(`You line it up, drop the claw, and it closes on ${prize}. It lifts. It swings. It holds. It drops into the chute. ${prize.charAt(0).toUpperCase() + prize.slice(1)} is yours. A good gift, if you can part with it.`);
      return ctx.ok({ kinds: [...ctx.kinds, 'game.claw.motor', 'game.claw.win'] });
    }
    await setAttrs(ctx.ch, { 'life.clawMisses': misses + 1 });
    ctx.life.clawMisses = misses + 1;
    ctx.say(pick([
      'The claw closes on a pink octopus, lifts it an inch, and lets go with what you would swear was a shrug.',
      'You drop it dead center. The claw pats the top of a raccoon, gently, like it is apologizing.',
      'It grabs a bumblebee by one wing and carries it almost to the chute. Almost.',
      'The claw comes up empty and swings back home, pleased with itself.',
    ]) + (misses >= 3 ? ' Teddy, passing: "It is due. I am not saying that. But it is due."' : ''));
    return ctx.ok({ kinds: [...ctx.kinds, 'game.claw.motor', 'game.claw.drop'] });
  },
  buttons: btn('starlite_arcade', 'Try the claw machine ($1)', 'claw machine'),
});

const PRIZES = [
  { key: 'fortune', name: 'a paper fortune', cost: 5, desc: 'Folded tight. It says: YOU WILL FIND WHAT YOU LOST WHEN YOU STOP LOOKING FOR IT. That is also what it says to everybody.' },
  { key: 'sticky hand', name: 'a sticky hand on a string', cost: 10, desc: 'Purple, stretchy, and already covered in lint.' },
  { key: 'rubber duck', name: 'a rubber duck', cost: 15, desc: 'Yellow, squeaks, and floats better than you do.' },
  { key: 'kazoo', name: 'a kazoo', cost: 20, desc: 'An instrument, technically. Busk with it at your own risk.', props: { instrument: 'kazoo', value: 1 } },
  { key: 'yoyo', name: 'a glow-in-the-dark yo-yo', cost: 25, desc: 'Glows a weak green. Sleeps for exactly one second.' },
  { key: 'glasses', name: 'a pair of joke glasses with a nose', cost: 30, desc: 'Big plastic nose, bushy eyebrows. A disguise that fools nobody and delights everybody.' },
  { key: 'snow globe', name: 'a snow globe of the bell tower', cost: 60, desc: 'Shake it and it snows on a tiny bell tower. The tiny clock is painted wrong, too.' },
  { key: 'giant bear', name: 'a stuffed bear bigger than you', cost: 150, desc: 'Enormous, blue, and impossible to carry through a door gracefully. It fits in your pocket anyway. This city is kind like that.' },
];
registry.register({
  name: 'prizes', aliases: ['prize counter', 'trade tickets', 'tickets', 'redeem tickets', 'prize'],
  help: { topic: 'fun', usage: 'prizes · prizes <name>', blurb: 'Trade Starlite tickets for prizes at the counter.' },
  async run(ctx, { arg }) {
    const have = Math.floor(ctx.life.tickets || 0);
    const want = String(arg || '').trim().toLowerCase().replace(/^(a|an|the)\s+/, '');
    if (!want || ctx.ch.roomId !== 'starlite_arcade') {
      ctx.say(`You have ${plural(have, 'ticket')}. ${ctx.ch.roomId === 'starlite_arcade' ? 'The prize counter has:' : 'At the Starlite prize counter:'} ${PRIZES.map((p) => `${p.name}, ${p.cost}`).join('; ')}.`);
      return ctx.ok(ctx.ch.roomId === 'starlite_arcade' ? { choices: PRIZES.map((p) => ({ label: `${cap(p.name)} (${p.cost} tickets)${have < p.cost ? ', not yet' : ''}`, cmd: `prizes ${p.key}` })) } : {});
    }
    const p = PRIZES.find((x) => x.key === want || x.name.includes(want));
    if (!p) return ctx.fail(`No prize called "${arg}". "prizes" lists them.`);
    if (have < p.cost) return ctx.fail(`${cap(p.name)} is ${p.cost} tickets. You have ${have}. Pinball and skee-ball pay tickets.`);
    const claimed = await MooChar.updateOne({ _id: ctx.ch._id, 'attrs.life.tickets': { $gte: p.cost } }, { $inc: { 'attrs.life.tickets': -p.cost } });
    if (!claimed.modifiedCount) return ctx.fail('Your tickets changed before that went through. Count them again with "prizes".');
    ctx.life.tickets = have - p.cost;
    await makeItem({ name: p.name, desc: p.desc, location: { type: 'char', id: ctx.userId }, props: { prize: true, giftable: true, gift: 'friend', value: 0, ...(p.props || {}) } });
    ctx.say(`Teddy counts your tickets twice, which is policy, and hands over ${p.name}.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'game.tickets'] });
  },
  buttons: btn('starlite_arcade', 'Prize counter', 'prizes'),
});

/* ── THE EARLY BIRD BAKERY ─────────────────────────────────────────────── */
const BAKES = [
  { min: 0, name: 'a loaf of bread you baked', desc: 'Crusty, a little lopsided, and still warm. You made that.', food: { feed: 14, line: 'You tear into your own bread. It is better than it has any right to be.' } },
  { min: 3, name: 'a pan of cinnamon buns you baked', desc: 'Six of them, sticky and fat, glazed a little unevenly. The smell follows you.', food: { feed: 12, fun: 8, line: 'You pull one cinnamon bun loose and the glaze goes everywhere. Worth it.' } },
  { min: 5, name: 'a pie you baked', desc: 'A lattice top you are secretly proud of and a filling that bubbled over just right.', food: { feed: 16, fun: 10, line: 'Your own pie, one slice, standing up at the counter. Roz would approve. Probably.' } },
];
registry.register({
  name: 'bake', aliases: ['bake bread', 'bake something', 'bake a pie', 'bake buns', 'bake cinnamon buns'],
  help: { topic: 'fun', usage: 'bake', blurb: 'Use Roz’s spare oven at the Early Bird Bakery. Two dollars for flour and butter; what comes out is yours to eat or give away.' },
  when: here('early_bird_bakery'),
  whyNot: () => 'Roz’s spare oven is at the Early Bird Bakery, off Gully Road.',
  async run(ctx) {
    if (!(await cooldown(ctx, 'bake', 20000))) return ctx.fail('Something is still in the oven. Give it a minute.');
    if (!(await payCoin(ctx.ch, 2))) return ctx.fail('Roz wants two dollars for the flour and butter. "Nobody bakes on credit. Not even me."');
    const lvl = level(ctx, 'cooking');
    const b = [...BAKES].reverse().find((x) => lvl >= x.min);
    await makeItem({ name: b.name, desc: b.desc, location: { type: 'char', id: ctx.userId }, props: { food: b.food, giftable: true, gift: 'friend', baked: true, value: 2 } });
    await setBusy(ctx.ch, 12, 'baking');
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} slides a tray into Roz’s spare oven. The whole room smells like it.`, 'obj.oven.door');
    ctx.need({ fun: 10, fed: 3 });
    ctx.learn('cooking', 4);
    ctx.say(`You knead, shape, wait, and pull out ${b.name}. Roz leans over, looks, and says "Hm," which from Roz is a medal. Eat it ("eat ${b.name.replace(/^(a|an)\s+/, '').split(' you')[0]}") or give it to somebody who needs it.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'obj.oven.door'] });
  },
  buttons: btn('early_bird_bakery', 'Bake something ($2)', 'bake'),
});

/* ── THE SWEETWATER BATHHOUSE ──────────────────────────────────────────── */
registry.register({
  name: 'swim laps', aliases: ['laps', 'do laps', 'swim some laps'],
  help: { topic: 'fun', usage: 'swim laps', blurb: 'Laps in the long lanes at the Sweetwater Bathhouse. Fitness, and clean.' },
  when: here('sweetwater_bathhouse'),
  whyNot: () => 'The lap lanes are at the Sweetwater Bathhouse, off the park.',
  async run(ctx) {
    const f = level(ctx, 'fitness');
    const laps = 4 + f * 3;
    await setBusy(ctx.ch, 12, 'swimming laps');
    ctx.need({ clean: 35, fun: 8, rested: -6, fed: -4 });
    ctx.learn('fitness', 5);
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} swims laps in the far lane.`, 'obj.water.laps');
    ctx.say(`You swim ${laps} laps. ${f < 2 ? 'By the last one you are hanging on the rope and breathing like a bellows.' : f < 5 ? 'Your arms find a rhythm around lap six and keep it.' : 'You stop counting. The water does the counting for you.'} Mabel lifts two fingers from the chair, which means good.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'obj.water.laps'] });
  },
  buttons: btn('sweetwater_bathhouse', 'Swim laps', 'swim laps'),
});
registry.register({
  name: 'cannonball', aliases: ['do a cannonball', 'jump in the deep end', 'dive in'],
  help: { topic: 'fun', usage: 'cannonball', blurb: 'Into the deep end at the Sweetwater Bathhouse. Mabel pretends to disapprove.' },
  when: here('sweetwater_bathhouse'),
  whyNot: () => 'Save the cannonball for the deep end at the Sweetwater Bathhouse.',
  async run(ctx) {
    await setBusy(ctx.ch, 4, 'dripping');
    ctx.need({ fun: 16, clean: 20 });
    const company = await others(ctx);
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} runs, tucks, and cannonballs into the deep end. The wave reaches the lifeguard chair. Mabel blows the whistle, then laughs.`, 'obj.water.splash.big');
    ctx.say(`You hit the water like a dropped piano. ${company.length ? `${firstName(company[0])} gets soaked and does not seem to mind.` : 'The wave slaps the far wall and comes back to say hello.'} Mabel blows her whistle, then laughs anyway.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'obj.water.splash.big'] });
  },
  buttons: btn('sweetwater_bathhouse', 'Cannonball', 'cannonball'),
});
registry.register({
  name: 'sauna', aliases: ['sit in the sauna', 'use the sauna', 'steam'],
  help: { topic: 'needs', usage: 'sauna', blurb: 'Cedar and steam at the Sweetwater Bathhouse. Rest and clean.' },
  when: here('sweetwater_bathhouse'),
  whyNot: () => 'The sauna is at the Sweetwater Bathhouse, off the park.',
  async run(ctx) {
    await setBusy(ctx.ch, 10, 'sweating in the sauna');
    ctx.need({ rested: 22, clean: 25, fun: 4 });
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} disappears into the sauna. Steam puffs out around the door.`, 'obj.sauna.steam');
    ctx.say('You ladle water on the stones and they hiss like a kettle. The heat goes into your shoulders and takes the day out of them. You come out pink and slow and very clean.');
    return ctx.ok({ kinds: [...ctx.kinds, 'obj.sauna.steam'] });
  },
  buttons: btn('sweetwater_bathhouse', 'Sauna', 'sauna'),
});
registry.register({
  name: 'soak', aliases: ['hot tub', 'sit in the hot tub', 'soak in the hot tub'],
  help: { topic: 'needs', usage: 'soak', blurb: 'The hot tub at the Sweetwater Bathhouse. Better with company.' },
  when: here('sweetwater_bathhouse'),
  whyNot: () => 'The hot tub is at the Sweetwater Bathhouse, off the park.',
  async run(ctx) {
    const company = await others(ctx);
    await setBusy(ctx.ch, 8, 'soaking in the hot tub');
    ctx.need({ rested: 14, fun: 8, company: company.length ? 10 : 0 });
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} eases into the hot tub with a long, happy groan.`, 'obj.water.bubbles');
    ctx.say(company.length ? `You ease into the hot tub. ${firstName(company[0])} is close enough to talk to, and the bubbles cover the pauses.` : 'You ease into the hot tub. The bubbles take over the job of thinking for a while.');
    return ctx.ok({ kinds: [...ctx.kinds, 'obj.water.bubbles'] });
  },
  buttons: btn('sweetwater_bathhouse', 'Soak in the hot tub', 'soak'),
});

/* ── THE EASEL: painting, in your own words ───────────────────────────── */
const MEDIUMS = ['oil', 'watercolor', 'acrylic', 'charcoal', 'pastel', 'gouache'];
const QUALITY = [
  'The lines wobble, but the feeling is there.',
  'It is clearly what it is supposed to be, and it is clearly yours.',
  'The colors sit well together. Somebody would hang this.',
  'The light in it looks like real light.',
  'It pulls you in closer to look at the brushwork.',
  'People will stop in front of this one.',
  'It looks like you could step into it.',
  'It is the kind of painting that makes a room.',
  'Anselm stares at it for a long time and says nothing, which is the highest thing he says.',
  'It belongs in the Archive, and one day it will be there.',
];
function cleanTitle(words) {
  // eslint-disable-next-line no-control-regex
  return String(words || '').replace(/[\u0000-\u001f\u007f"“”]/g, '').replace(/\s+/g, ' ').trim().replace(/^(a|an|the)\s+(painting|picture)\s+of\s+/i, '').replace(/^of\s+/i, '').slice(0, 70);
}
async function mayPaintHere(ctx) {
  if (ctx.ch.roomId === 'the_easel') return 'studio';
  const room = await ctx.room();
  if (room && room.props && room.props.home && await MooItem.exists({ 'location.type': 'room', 'location.id': room.roomId, 'props.furniture': 'easel' })) return 'home';
  return null;
}
registry.register({
  name: 'paint', aliases: ['paint a picture', 'paint a painting', 'make a painting'],
  help: { topic: 'fun', usage: 'paint <what you want to paint>', blurb: 'At the Easel on Fairlawn Avenue ($3 a canvas), or at home with an easel. Paint anything, in your own words. Hang it, sell it, or give it away.' },
  async run(ctx, { argRaw }) {
    const where = await mayPaintHere(ctx);
    if (!where) return ctx.fail('Painting happens at the Easel on Fairlawn Avenue, or at home if you have an easel.');
    const title = cleanTitle(argRaw);
    if (!title) {
      ctx.say('What do you want to paint? Say it after the word paint: "paint the ferry at night", "paint my grandmother’s kitchen", "paint a cat asleep in a sink". Anything at all.');
      return ctx.ok({ freeText: true, choices: [{ label: 'Paint the view from the window', cmd: 'paint the view from the window' }, { label: 'Paint somebody here', cmd: 'paint the people in this room' }, { label: 'Type your own', cmd: 'paint ', compose: true }] });
    }
    if (!(await cooldown(ctx, 'paint', 20000))) return ctx.fail('Let the last one dry a moment first.');
    if (where === 'studio' && !(await payCoin(ctx.ch, 3))) return ctx.fail('A canvas is three dollars. Anselm will not budge. "Canvas is the only thing in here that costs money. The ideas are free."');
    const lvl = level(ctx, 'painting');
    const quality = Math.max(1, Math.min(10, lvl + (Math.random() < 0.3 ? 1 : 0)));
    const medium = MEDIUMS[hashStr(`${ctx.userId}|${title}`) % MEDIUMS.length];
    const value = Math.round(3 + quality * quality * 0.6);
    const name = `a painting: ${title}`;
    await makeItem({
      name,
      desc: `A ${medium} painting of ${title}, signed ${ctx.ch.name} in the corner. ${QUALITY[quality - 1]}`,
      location: { type: 'char', id: ctx.userId },
      props: { furniture: 'painting', painting: { title, painter: ctx.ch.name, painterId: ctx.userId, quality, medium, at: Date.now() }, effect: 'It hangs on your wall. Visitors can look at it.', value, giftable: true, gift: 'friend' },
    });
    await setBusy(ctx.ch, 15, 'painting');
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `${ctx.ch.name} paints ${title}, in ${medium}.`, 'obj.brush.stroke');
    ctx.need({ fun: 16, rested: -3 });
    ctx.learn('painting', 5);
    ctx.say(`You paint ${title}, in ${medium}. ${QUALITY[quality - 1]} It is yours now: hang it at home ("place painting"), give it to somebody, or ${where === 'studio' ? `sell it to the gallery for about $${value} ("sell painting")` : 'sell it at the Easel on Fairlawn Avenue'}.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'obj.brush.stroke'] });
  },
  buttons: async (ctx) => ((await mayPaintHere(ctx)) ? [{ label: 'Paint something', cmd: 'paint', group: 'here' }] : []),
});
registry.register({
  name: 'sketch', aliases: ['draw', 'doodle', 'practice drawing'],
  help: { topic: 'fun', usage: 'sketch', blurb: 'Charcoal on scrap paper at the Easel. Free practice for your Painting.' },
  when: async (ctx) => !!(await mayPaintHere(ctx)),
  whyNot: () => 'Sketch at the Easel on Fairlawn Avenue, where the scrap paper is free.',
  async run(ctx) {
    if (!(await cooldown(ctx, 'sketch', 10000))) return ctx.fail('Your hand needs a moment. Look at something first.');
    const people = await others(ctx);
    const subject = people.length ? `${firstName(people[hashStr(String(Date.now())) % people.length])}, who does not notice` : pick(['a jar of brushes', 'your own left hand', 'the window and the light in it', 'a coffee cup nobody washed']);
    await setBusy(ctx.ch, 6, 'sketching');
    ctx.need({ fun: 7 });
    ctx.learn('painting', 2);
    ctx.say(`You sketch ${subject}. The charcoal smudges your fingers. It is practice, and practice counts.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'obj.charcoal.scratch'] });
  },
  buttons: btn('the_easel', 'Sketch (free)', 'sketch'),
});
registry.register({
  name: 'gallery', aliases: ['browse the gallery', 'look at the gallery', 'the gallery', 'paintings for sale'], free: true,
  help: { topic: 'fun', usage: 'gallery', blurb: 'The paintings hanging for sale at the Easel, made by people in this city.' },
  async run(ctx) {
    const wall = await MooItem.find({ 'location.type': 'room', 'location.id': 'the_easel', 'props.gallery': true }).sort({ createdAt: -1 }).limit(40).lean();
    if (!wall.length) {
      ctx.say('The gallery wall at the Easel has room on it. Anselm is waiting for somebody who says they cannot paint.');
      return ctx.ok();
    }
    ctx.say(`On the gallery wall at the Easel: ${wall.slice(0, 12).map((p) => `${p.props.painting.title}, ${p.props.painting.medium} by ${p.props.painting.painter}, $${p.props.price}`).join('; ')}.${wall.length > 12 ? ` And ${wall.length - 12} more.` : ''}`);
    return ctx.ok(ctx.ch.roomId === 'the_easel' ? { choices: wall.slice(0, 12).map((p) => ({ label: `Buy ${p.props.painting.title} ($${p.props.price})`, cmd: `buy painting ${p.props.painting.title}` })) } : {});
  },
  buttons: btn('the_easel', 'The gallery wall', 'gallery'),
});
registry.register({
  name: 'sell painting', aliases: ['sell my painting', 'sell a painting', 'sell the painting'],
  help: { topic: 'money', usage: 'sell painting · sell painting <title>', blurb: 'Sell one of your paintings to the gallery at the Easel. It hangs there for anybody to buy.' },
  when: here('the_easel'),
  whyNot: () => 'Paintings sell at the Easel on Fairlawn Avenue.',
  async run(ctx, { arg }) {
    const mine = await MooItem.find({ 'location.type': 'char', 'location.id': ctx.userId, 'props.painting': { $exists: true } }).lean();
    if (!mine.length) return ctx.fail('You are not carrying a painting. "paint <anything>" makes one.');
    const it = arg ? matchName(mine, arg, (i) => i.props.painting.title) : mine[0];
    if (!it) return ctx.fail(`None of your paintings is called "${arg}". You carry: ${mine.map((p) => p.props.painting.title).join('; ')}.`);
    const day = worldClock().dayKey;
    const sold = ctx.life.gallerySold && ctx.life.gallerySold.day === day ? ctx.life.gallerySold.n : 0;
    if (sold >= 3) return ctx.fail('Anselm shakes his head, kindly. "Three of yours on the wall this week is plenty. Keep painting. Bring me the next one tomorrow."');
    const pay = it.props.value || 5;
    const moved = await MooItem.updateOne({ _id: it._id, 'location.type': 'char', 'location.id': ctx.userId }, { $set: { location: { type: 'room', id: 'the_easel' }, portable: false, 'props.gallery': true, 'props.price': Math.round(pay * 1.5) } });
    if (!moved.modifiedCount) return ctx.fail('That painting moved before the sale went through.');
    await earnCoin(ctx.ch, pay);
    ctx.life.gallerySold = { day, n: sold + 1 };
    await setAttrs(ctx.ch, { 'life.gallerySold': ctx.life.gallerySold });
    await emit(ctx.ch.roomId, ctx.userId, ctx.ch.name, 'emote', `Anselm hangs ${ctx.ch.name}’s painting, ${it.props.painting.title}, on the gallery wall.`, 'coin');
    ctx.say(`Anselm pays you $${pay} and hangs ${it.props.painting.title} on the gallery wall with a card that says your name. Anybody in the city can buy it now.`);
    return ctx.ok({ kinds: [...ctx.kinds, 'coin'] });
  },
  buttons: async (ctx) => (ctx.ch.roomId === 'the_easel' && await MooItem.exists({ 'location.type': 'char', 'location.id': ctx.userId, 'props.painting': { $exists: true } }) ? [{ label: 'Sell a painting', cmd: 'sell painting', group: 'here' }] : []),
});
registry.register({
  name: 'buy painting', aliases: ['buy a painting', 'buy the painting'],
  help: { topic: 'money', usage: 'buy painting <title>', blurb: 'Buy a painting off the gallery wall at the Easel. Hang it at home.' },
  when: here('the_easel'),
  whyNot: () => 'The gallery is at the Easel on Fairlawn Avenue.',
  async run(ctx, { arg }) {
    const wall = await MooItem.find({ 'location.type': 'room', 'location.id': 'the_easel', 'props.gallery': true }).lean();
    const it = arg ? matchName(wall, arg, (i) => i.props.painting.title) : null;
    if (!it) return ctx.fail(arg ? `No painting called "${arg}" on the wall. "gallery" lists them.` : 'Buy which painting? "gallery" lists them.');
    const price = it.props.price || 10;
    if (!(await payCoin(ctx.ch, price))) return ctx.fail(`${it.props.painting.title} is $${price}. You carry $${coinOf(ctx.ch)}.`);
    const moved = await MooItem.updateOne({ _id: it._id, 'location.id': 'the_easel' }, { $set: { location: { type: 'char', id: ctx.userId }, portable: true, 'props.gallery': false } });
    if (!moved.modifiedCount) { await earnCoin(ctx.ch, price); return ctx.fail('Somebody bought it a second before you did. Your money is back in your pocket.'); }
    ctx.say(`Anselm wraps ${it.props.painting.title} in brown paper. "${it.props.painting.painter} will be glad," he says. Hang it at home with "place painting".`);
    return ctx.ok({ kinds: [...ctx.kinds, 'coin'] });
  },
});

module.exports = { VENUES, VENUE_BY_ID, FILMS, billFor, PLUSH, PRIZES, BAKES, seed, cleanTitle };
