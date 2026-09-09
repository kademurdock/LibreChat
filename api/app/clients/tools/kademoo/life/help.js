/* REVERIE LIFE — help (Sep 6 2026).
 *
 * A help system a person can actually use with their ears: short topics,
 * plain words, one screen each, and every verb's own line pulled from its
 * registration so the help can never drift from the code. "help" alone is
 * the front door; "help <topic>" a room; "help <verb>" one thing. The result
 * carries `choices` so the topics are buttons, too. */
const registry = require('./registry');

const TOPICS = {
  start: { title: 'Getting started', text: 'You are a person in a city. Walk with the compass or "go to <place>". "look" is your eyes; "what" says what you can do right here; tap a name (or "chat <name>") to talk. Eat where food is, sleep where it is safe, work where there is work. Rent a place ("listings"), fill it, invite people. The city keeps going whether you type or not — leave the page open and you will hear it.' },
  moving: { title: 'Getting around', text: 'Directions: n s e w ne nw se sw up down, or the compass. "go to <place>" walks you there by name — "places" lists every place by ward. "tram <stop>" ($1) and "ferry" ($1) cross the city. Own a bike or car from the Garages and "go to" uses it; "walk" to go on foot. "cab <place>" calls Medallion 88. "home" goes home. "back" retraces one step.' },
  senses: { title: 'Looking and listening', text: '"look" for the room, "look <thing or person>" up close, "look me" for yourself. "listen" and "chord" for the sound of the room. "sniff" for the smell. "exits", "where", "time", "weather", "who" (who is playing), "recap" replays what you missed.' },
  people: { title: 'People', text: 'Citizens live here on schedules; players come and go; you cannot always tell which is which, on purpose. "talk to <citizen>" hears them in their own words. "chat", "joke", "compliment", "hug", "comfort", "flirt", "kiss", "date", "argue", "insult", "apologize", "gift <thing> to <name>". Friendship and romance grow from what you do; "relationships" shows where you stand with everybody. "say <words>" talks to the room; "speak" says it aloud; "whisper <name> <words>" is private. Thirty-six gestures ("socials") take adverbs and targets: "nod slowly", "wave to Merle". "pose <what you are doing>" shows beside your name. Players say yes first: a kiss, a proposal, a fight, a move-in are offers — "accept" or "decline".' },
  needs: { title: 'Your meters', text: 'Fed, rested, clean, fun, company — 0 to 100. They only fall while you are playing, never while you are away, and nothing here can kill you: low just means uncomfortable, and the city says so. "status" reads them. Food is where the people are ("eat"). Sleep anywhere safe ("sleep"); your own bed is best. "shower" at home or "swim" off a pier. Fun is everything under "help fun". Company is people. Your mood is the average, and good moods learn faster.' },
  you: { title: 'You', text: '"status" (mood, meters, money), "skills" (ten of them — cooking, fishing, charm, handy, garden, music, fitness, hustle, learning, care — grown by doing), "inventory", "look me", "record" (marks). "describe me as <text>" sets how you look. "pronouns <she|he|they>". "walk-style <how>". Three characters to an account: "newchar", "switch <name>", "chars".' },
  money: { title: 'Money and work', text: 'Coin. "work" a shift where there is work — the docks, the Archive desk, Pat’s sink, Dez’s bar, the salvage scale, the plots, the fields, the orchard — six shifts a day; shifts add up to promotions and raises ("careers"). Fish and sell the catch ("help fishing"). Forage and grow and sell at merchants. "busk" with an instrument. "pawn <thing>" at Hock’s. "shop" and "buy <thing>" at any counter. Cards and scratch tickets are money going the other way, usually.' },
  home: { title: 'A place of your own', text: '"listings" shows nine places for rent across the wards, from a room over Pat’s to a house behind the Fairlawn gates. "rent <listing>" takes the deposit and first week; rent comes out weekly on its own — behind is a nag and a rumor, never an eviction. "home" goes there. "furnish" says what it has and could use; buy furniture at Hock’s Pawn or cheap at the Salvage Yard, carry it home, "place <thing>". A bed sleeps you properly, a stove cooks, a shower cleans, a couch relaxes, a radio plays the Band, a crib or bunk is for kids. "door open|friends|locked" sets who walks in; "give key to <name>"; "visit <name>"; "knock"; "let <name> in". "buy house" owns it outright where they sell. "porch" to sit out front.' },
  family: { title: 'Family', text: 'Partners: flirt, date, propose (with a ring from Hock’s), "marry" at the Courthouse. "move in with <name>" shares a roof. Children: the Children’s Office in the Archive — Miss Reed’s list changes daily ("adopt", then "adopt <name>"; you need a home with a crib or bunk and thirty dollars) — or "have baby <name>" with your partner at home. Kids live at your place, grow on the real calendar (baby a day, toddler three, kid six, teen eight, then grown), and go to school on Treehouse Row. "feed", "play with", "read to", "teach", "tuck in", "talk to", "bring" (they follow), "stay". A grown child: "claim <name>" to play them. "family" shows the household. Pets: earn a stray’s trust ("approach", "pet", "offer <food> to"), "adopt" it ($15), "call <it> <name>", "bring <name>".' },
  fun: { title: 'Things to do', text: 'Bowl ten frames at the Millrace Lanes ("bowl", then "roll" / "roll hook"). Darts at Dez’s ("darts", "throw"). Cards in the Game Parlor ("play cards <bet>", "hit", "stand"). "sing" at Dez’s or the Bandshell; "dance"; "busk" for tips with a guitar from Hock’s. "read" at the Archive or your bookshelf. "workout" on the Stairs or the Union Hall steps. "radio" for the Band. "swim" off the Pier. "cook" ("recipes"). Explore outdoors with explore: Alder Trail, Reedbank Creek, Alder Camp, and Alder Hide. Track wildlife, photograph wildlife, field journal, rest by fire, or hunt for optional small-game choices. Explore outdoors with explore: Alder Trail, Reedbank Creek, Alder Camp, and Alder Hide. Track wildlife, photograph wildlife, field journal, rest by fire, or hunt for optional small-game choices. Fish ("help fishing"). Grow ("help garden"). "flatten penny" at the Grade Crossing. "wish" at the fountain. "scores" for the boards.' },
  fishing: { title: 'Fishing', text: 'For untimed fishing, choose easy fish at the water, then easy fish keep or easy fish release. A loaner pole is included; wait a minute between catches. For the original reaction game, buy a rod and bait at the Shack (the Hook). At the water — Pier Seven, the Breakwater, the Lake Dock, the Pier — "cast". Then LISTEN: a nibble and a take are two different sounds. "set" (or "strike") on the take. Then "hold" or "give" line as it fights — snap it and it is gone. "land". "release" or keep it and "sell" at the market, or cook it. Fishing skill grows every catch.' },
  garden: { title: 'Growing and foraging', text: '"forage" (and "almanac" for what is in season) in the wild spots. At the Garden Plots: "plot" to claim, "plant <crop>", "water", "weed", "check", "pick", "pull". Crops grow on real days. Sell at merchants, cook, or gift. The orchard sells apples and cider.' },
  drama: { title: 'Trouble', text: 'Not candy land. Words go to shoves go to hands — never past bruised, and players only fight players who "accept". Each ward has its law: nothing in Sweetwater or near kids; the Fairlawn HOA fines you; the Hook, the Patch and Tanglefoot shrug. "pickpocket <citizen>" where the law shrugs — Sgt. Vann catches you sometimes and Honorable Pham’s night court fines you and marks you for two weeks. Little Ray on Gully Road after dark sells a little something ("corner", "use") — fun up, everything else down, and a habit if you keep on. What you do becomes what people say: "rumors" at Levi’s, the Salon, Pat’s, Ruth-Ann’s stoop, Dez’s, or on the radio.' },
  sound: { title: 'Sound', text: 'Notice surroundings reads sounds, smells, and the ground. Walking cues follow the surface and rain. New web backgrounds include woods, creek, campfire, home, and archive. Sounds carry the game: your screen reader announces, the earcons play. Toggle sounds and ambience in the bar. Each ward has a sound bed and rooms have their own tone; the freight horn at 11:40 reaches every ward at its own distance. A bite while fishing is a sound, not a line. Web and Android World: Room picture and World motion control the new 3D miniature; Describe the picture reads its artistic design. Every game detail remains in text and sound.' },
  builder: { title: 'Building (wizards)', text: '@dig, @desc, @create, @itemdesc, @exit, @unexit, @tp, @rooms, @set, @zap, @district, @sound, @age <child> <days>. "angel: <plain English>" asks the Angel to build.' },
};
const ORDER = ['start', 'moving', 'senses', 'people', 'needs', 'you', 'money', 'home', 'family', 'fun', 'fishing', 'garden', 'drama', 'sound'];

registry.register({
  name: 'help', aliases: ['?', 'commands', 'how do i', 'how to'], free: true,
  help: { topic: 'help', usage: 'help · help <topic> · help <verb>', blurb: 'This.' },
  async run(ctx, { arg }) {
    arg = (arg || '').trim().toLowerCase();
    if (!arg) {
      ctx.say('Reverie is a city you live in. Tap the buttons or type — both work. Topics: ' + ORDER.map((k) => `${k} (${TOPICS[k].title})`).join(', ') + '. Say "help <topic>" or "help <verb>". "what" tells you what you can do right where you stand.');
      return ctx.ok({ choices: ORDER.map((k) => ({ label: TOPICS[k].title, cmd: `help ${k}` })) });
    }
    const tkey = Object.keys(TOPICS).find((k) => k === arg || TOPICS[k].title.toLowerCase().includes(arg));
    if (tkey && (arg.length >= 3 || tkey === arg)) {
      const t = TOPICS[tkey];
      ctx.say(`${t.title}. ${t.text}`);
      const verbs = registry.all().filter((v) => !v.hidden && v.help && v.help.topic === tkey);
      if (verbs.length) ctx.say('Verbs: ' + verbs.map((v) => v.help.usage || v.name).join(' · '));
      return ctx.ok({ choices: [{ label: 'All topics', cmd: 'help' }, ...verbs.slice(0, 10).map((v) => ({ label: v.name, cmd: `help ${v.name}` }))] });
    }
    const v = registry.get(arg) || registry.all().find((x) => x.name.startsWith(arg) || x.aliases.some((a) => a.startsWith(arg)));
    if (v && v.help) {
      ctx.say(`${v.name}: ${v.help.blurb || ''} Usage: ${v.help.usage || v.name}.${v.aliases.length ? ` Also: ${v.aliases.slice(0, 6).join(', ')}.` : ''}`);
      return ctx.ok({ choices: [{ label: `More on ${v.help.topic || 'help'}`, cmd: `help ${v.help.topic || ''}`.trim() }] });
    }
    /* old-engine words the registry does not know */
    const OLD = { cast: 'fishing', set: 'fishing', hold: 'fishing', land: 'fishing', reel: 'fishing', forage: 'garden', plant: 'garden', water: 'garden', pick: 'garden', socials: 'people', emote: 'people', pose: 'people', whisper: 'people', speak: 'people', say: 'people', petition: 'fun', wish: 'fun', tram: 'moving', ferry: 'moving', approach: 'family', pet: 'family', strays: 'family', chord: 'senses', sniff: 'senses', map: 'moving' };
    if (OLD[arg]) return this.run(ctx, { arg: OLD[arg] });
    return ctx.fail(`No help for "${arg}". Topics: ${ORDER.join(', ')}.`);
  },
  buttons: () => [{ label: 'Help', cmd: 'help', group: 'self' }],
});

registry.register({
  name: 'hint', aliases: ['what should i do', 'suggest', 'idea'], free: true,
  help: { topic: 'help', usage: 'hint', blurb: 'One thing worth doing next.' },
  async run(ctx) {
    const needs = require('./needs');
    const nd = ctx.life.needs || needs.fresh();
    const w = needs.worst(nd);
    const room = await ctx.room();
    if (nd[w] < 40) { ctx.say(needs.HINTS[w]); return ctx.ok(); }
    const ideas = [];
    if (!ctx.life.home) ideas.push('Find a place of your own — "listings" — a room over Pat’s is eighteen a week.');
    if (ctx.life.home) { const has = await require('./ctx').MooItem.countDocuments({ 'location.type': 'room', 'location.id': ctx.life.home, 'props.furniture': { $exists: true } }); if (has < 3) ideas.push('Your place is bare. Hock’s Pawn on Line Street sells a bed and a stove; the Salvage Yard sells them dented and cheap.'); }
    const coin = require('./ctx').coinOf(ctx.ch);
    if (coin < 15) ideas.push('Money is low. Work a shift — the docks pay, so does Pat’s sink — or fish off Pier Seven and sell the catch.');
    const rels = await require('./relationships').relsOf(ctx.userId);
    if (rels.filter((r) => r.friendship >= 30).length < 2) ideas.push('Make a friend. Chat with a citizen twice; joke once. Merle owes everybody a favor.');
    ideas.push('Bowl a game at the Millrace Lanes and get on the board.', 'Buy a scratch ticket at the Corner Store. Somebody has to win.', 'Go hear the gossip at Levi’s Chairs.', 'Flatten a penny at the Grade Crossing at 11:40.', 'Walk the Gravewalk. Nobody who has says nothing about it.', 'Sing at Dez’s. Badly is fine.', 'Take the ferry for the ride.', 'Find the gray cat on Gully Road and earn its trust.', 'Read something at the Archive and win an argument at Levi’s with it.');
    ctx.say(require('./ctx').pick(ideas.slice(0, 3)) || ideas[0]);
    return ctx.ok();
  },
  buttons: () => [{ label: 'Give me an idea', cmd: 'hint', group: 'self' }],
});

module.exports = { TOPICS, ORDER };
