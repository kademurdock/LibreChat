/* REVERIE — the city, carved (Aug 10 2026, from REVERIE_FOUNDERS_PLAN v2).
 * This file is DATA plus deterministic systems: the wards, the streets, the
 * rooms, the census of synth citizens, the weather, and the world tick.
 * No model in any loop — the Game Parlor law holds here too. The engine
 * (engine.js) calls carveReverie() once per boot (idempotent, insert-if-
 * absent: it NEVER overwrites a room she or the Angel has touched) and
 * tickWorld() on a throttle from runCommand.
 *
 * Prose law (Part 11, enforced hardest on ourselves): high-school reading
 * level, short sentences, lead with ears and nose, the banned list is real
 * (no neon, bustling, vibrant, nestled, tapestry, symphony, testament-to),
 * specific beats pretty, and nothing described that can't be interacted with.
 */
const { MooRoom, MooChar, MooItem, MooDistrict, MooEvent, nextSeq } = require('~/models/kadeMoo');
const { logger } = require('@librechat/data-schemas');

const REVERIE_SEED_VERSION = 3;

/* ── THE WARDS ─────────────────────────────────────────────────────────────
 * District props carry the law tables (bible design: the engine never
 * hardcodes a district). mapLine feeds the `map` verb — relationships,
 * never grids. soundLine is the ward's ear-signature for `listen`/arrival. */
const WARDS = [
  {
    districtId: 'gate', name: 'the Threshold', props: {
      mapLine: 'The Threshold sits between the Bell and the water roads. Founder’s Square opens north into Court Street and the Bell. Coldpipe Alley slips west toward the Stairs and the Hook.',
      soundLine: 'lantern hiss and slow pigeons',
      law: { guns: 'restricted', ladderCap: 'weapons' },
    },
  },
  {
    districtId: 'bellward', name: 'Bellward', props: {
      mapLine: 'The Bell is the old quarter: Court Street runs through the middle of it. The Archive and the records office hold the north side, Mercy never closes on the east end, the bank and the Mark Exchange face each other, and the Founder’s Office sits at the top of the Archive. South is the Threshold. West is the Hook, east is Tanglefoot, northeast the lawns of Fairlawn, north the green of Sweetwater.',
      soundLine: 'the bell (late again) and pigeons',
      law: { guns: 'restricted', ladderCap: 'weapons' },
    },
  },
  {
    districtId: 'hook', name: 'the Hook', props: {
      mapLine: 'The Hook is the harbor ward. Front Street faces the water. The docks and the Union Hall are north along the chain-rattle, Pat’s diner burns its coffee at the water end of Front Street, the fish market wakes before anyone, and the ferry leaves for Sweetwater when Captain Marsh says so. The Stairs drop south to the Patch. East is the Bell.',
      soundLine: 'gulls, chain, and diesel idling',
      law: { guns: 'dont_ask', ladderCap: 'dying' },
    },
  },
  {
    districtId: 'tanglefoot', name: 'Tanglefoot', props: {
      mapLine: 'Tanglefoot is the night ward, strung along Line Street where the old streetcar ran. Dez’s bar bleeds music through its brick, the Band broadcasts from over the pawnshop, Hock’s pawn takes anything with a story, the Game Parlor never locks, and the taco window feeds the 3 a.m. line. West is the Bell. It does not really exist before dark.',
      soundLine: 'bass through brick and a sign that buzzes pink',
      law: { guns: 'restricted', ladderCap: 'dying', adult: true },
    },
  },
  {
    districtId: 'patch', name: 'the Patch', props: {
      mapLine: 'The Patch runs along Gully Road: row houses, stoops, laundry lines, the best cooking smells in the city. Levi’s Chairs holds the opinions, Ruth-Ann’s stoop holds the tomatoes, the corner store holds the nickels, Doc’s clinic holds everything else. The Stairs climb north to the Hook. Millrace grinds away to the east.',
      soundLine: 'kitchens and porch talk',
      law: { guns: 'dont_ask', ladderCap: 'dying' },
    },
  },
  {
    districtId: 'millrace', name: 'Millrace', props: {
      mapLine: 'Millrace is the makers’ ward, built along the old water channel. The salvage yard pays by weight, the garages fix what the yard finds, the junk market takes over on Saturdays, and the bowling lanes hold league night. The Patch is west. The freight line runs through on its way to the docks.',
      soundLine: 'grinders and somebody’s radio',
      law: { guns: 'licensed', ladderCap: 'dying' },
    },
  },
  {
    districtId: 'sweetwater', name: 'Sweetwater', props: {
      mapLine: 'Sweetwater is the green ward: the park, the garden plots, the bandshell, the wishing fountain, and the pier where the ferry ties up. Treehouse Row keeps the kid end soft. South is the Bell. The creek really is sweet, or was before the Hook got at it.',
      soundLine: 'water, wind, and ducks with no fear of anybody',
      law: { guns: 'banned', ladderCap: 'words', kid_safe: true },
    },
  },
  {
    districtId: 'fairlawn', name: 'Fairlawn', props: {
      mapLine: 'Fairlawn is the money ward. The avenue runs past lawns cut to the same inch, the salon where the polite knives come out, the homeowners’ hall, and the gates where private security smiles at you. Southwest is the Bell. East, past the ring road, the fields start.',
      soundLine: 'sprinklers and nothing',
      law: { guns: 'restricted', ladderCap: 'hands', hoa: true },
    },
  },
  {
    districtId: 'longacre', name: 'Long Acre', props: {
      mapLine: 'Long Acre is everything past the ring road: fields, the truck stop, the grass airfield, and the freight line running its one honest errand a night. The highway goes somewhere and mostly does not come back. Fairlawn is back west toward the city.',
      soundLine: 'wind in crops and a far-off engine',
      law: { guns: 'licensed', ladderCap: 'dying' },
    },
  },
  {
    districtId: 'gravewalk', name: 'the Gravewalk', props: {
      mapLine: 'The Gravewalk is where the dead wait. Lantern rows, a tea house, and the seance switchboard. The living do not walk in; they are reached for. Its ways back are not doors.',
      soundLine: 'your own footsteps, arriving a half-second late',
      law: { guns: 'meaningless', ladderCap: 'words' },
    },
  },
];

/* ── THE ROOMS ─────────────────────────────────────────────────────────────
 * props: outdoor (weather reaches you), doings (feeds `dir`), food {menu,
 * price}, job {name, wage, line, refusal}, sleepable, tram, ferry, opinion
 * (barbershop-layer room), seance, rails. */
const CITY_ROOMS = [
  /* ── BELLWARD ── */
  {
    roomId: 'bell_court_street', name: 'Court Street', district: 'bellward',
    desc: 'The Archive bell rings the hour somewhere overhead, late as always, and pigeons argue about it. Brick underfoot, bookshop dust and tea on the air. The Archive stands north, Mercy glows east at the street’s end, the bank and the Mark Exchange face off midblock, and the courthouse keeps its wide steps swept. The tram stops here.',
    exits: { s: 'founders_square', n: 'the_archive', e: 'mercy_hospital', w: 'hook_front_street', ne: 'fairlawn_ave', nw: 'sweetwater_park', se: 'tanglefoot_line_street', sw: 'millrace_channel', u: 'the_bank', d: 'mark_exchange' },
    props: { outdoor: true, tram: true, doings: 'Ride the tram. Step into the Archive, the bank, the Mark Exchange, Mercy, or the courthouse. Listen for the bell being wrong.' },
  },
  {
    roomId: 'the_archive', name: 'the Archive', district: 'bellward',
    desc: 'Paper, wax, and quiet — the loud kind of quiet a big reading room makes. Long tables, a row of terminals, shelves that go back further than the light does. The bell tower stairs are roped off with a sign that says SOON. The records office keeps a window at the back, and a narrow stair climbs to the Founder’s Office.',
    exits: { s: 'bell_court_street', n: 'records_office', u: 'founders_office', e: 'childrens_office', w: 'bureau_small_complaints' },
    props: { doings: 'Read at the long tables. Search the chronicle at a terminal. Ask Ines almost anything. The records office window is north; the Founder’s Office is up.', job: { name: 'the Archive desk', wage: 6, line: 'You shelve returns and square the card drawers while Ines hums off-key on purpose.', refusal: 'Ines slides the cart away from you. "The books need to miss you a little. Come back tomorrow."' } },
  },
  {
    roomId: 'records_office', name: 'the Records Office', district: 'bellward',
    desc: 'A window, a counter worn smooth by elbows, and one clerk’s eyebrow that does most of the talking. Ink and old paper. Names get made official here — first and last, like everyone on the ledger — and the fee jar takes what it takes. The old names never leave the book; that is the point of the book.',
    exits: { s: 'the_archive' },
    props: { doings: 'Register a name, change a name (the old one stays on your record forever), or ask what the ledger remembers.' },
  },
  {
    roomId: 'founders_office', name: 'the Founder’s Office, Waiting Room', district: 'bellward',
    desc: 'A small room that smells faintly of lemon polish and patience. Six chairs, a low table of magazines from years that have not happened, and a door whose sign has said BACK IN FIVE MINUTES since the city opened. Set into the door is a brass slot. When it takes a petition, it makes a sound like a throat clearing politely.',
    exits: { d: 'the_archive' },
    props: { doings: 'Wait, if you like waiting. Read a magazine from a year that has not happened. Slip a petition through the slot — petition <your words> works here best of anywhere, though she hears you from anywhere.' },
  },
  {
    roomId: 'mercy_hospital', name: 'Mercy', district: 'bellward',
    desc: 'Doors that open before you touch them, and behind them the small beeps of machines minding their own business. Clean linen and coffee gone stale on a warmer. Mercy does not close. It never has. The waiting chairs hold whoever the night brought in, and the nurses call everyone hon regardless of paperwork.',
    exits: { w: 'bell_court_street' },
    props: { sleepable: true, doings: 'Get patched up. Sit with somebody. Sleep in a waiting chair — nobody minds here.' },
  },
  {
    roomId: 'the_bank', name: 'the First Bell Bank', district: 'bellward',
    desc: 'Marble that makes every footstep sound like an announcement. Pens on chains, a clock that is — unlike the bell — exactly right, and Constance behind the last window with the ledgers squared. The vault door is mostly for show. Mostly.',
    exits: { d: 'bell_court_street' },
    props: { doings: 'Check your coin. Talk terms with Constance. Admire a correct clock in a ward famous for a wrong bell.' },
  },
  {
    roomId: 'mark_exchange', name: 'the Mark Exchange', district: 'bellward',
    desc: 'A shopfront with a counter, a wall of small wonders people paid real support for, and in the middle of the floor: the drum. Brass, waist-high, turned once a week with a crank that needs oil and never gets it — the squeak is tradition now. Wishes go in written small. A few come true every week, and the town crier lane of the Feed says whose.',
    exits: { u: 'bell_court_street' },
    props: { doings: 'Make your one open wish for a thing you cannot afford: wish <what you want, in your own words>. Ask Oleander how the Drawing works. Read the Book of Patrons.' },
  },
  {
    roomId: 'the_courthouse', name: 'the Courthouse', district: 'bellward',
    desc: 'Wide steps, tall doors, and inside, wood that creaks with opinions about your posture. Days, it runs the ordinary docket. Late nights it becomes the night court, and Honorable Pham sentences with flair — forty hours reshelving at the Archive, poetry section, that class of thing. The public benches fill for the good ones.',
    exits: { w: 'bell_court_street' },
    props: { doings: 'Watch the docket from the public benches. Court days ring the bell — the wrong bell, at the wrong time, which is how you know it counts.' },
  },
  {
    roomId: 'bureau_small_complaints', name: 'the Bureau of Small Complaints', district: 'bellward',
    desc: 'One desk, one drawer that will not quite shut for the paper in it, one man — Wendell — who takes every complaint in the city with total seriousness. Wind chimes, tram smells, autumn arriving late. Most of it goes in the drawer. Once in a while something gets fixed, and nobody has ever worked out the pattern.',
    exits: { e: 'the_archive' },
    props: { doings: 'File a complaint about anything. Anything. Wendell will write it down like it matters, because to him it does.' },
  },
  {
    roomId: 'childrens_office', name: 'the Children’s Office', district: 'bellward',
    desc: 'Warm light, low chairs, a desk with a drawer of butterscotch that is somehow never empty. Crayon drawings taped at kid height. Miss Ottoline Reed runs this room unfailingly calm, and the whole ward is a little more careful because she does.',
    exits: { w: 'the_archive' },
    props: { doings: 'Talk to Miss Reed. Anyone can tell her anything about any kid in the city, and she listens all the way to the end.' },
  },

  /* ── THE HOOK ── */
  {
    roomId: 'hook_front_street', name: 'Front Street', district: 'hook',
    desc: 'Gulls first, then chain, then the low diesel of something big idling out of sight. Front Street faces the water like it is keeping an eye on it. Salt and fish and rope. The docks rattle north, Pat’s diner steams at the water end, the fish market crowds the morning side, and the Stairs drop south toward the Patch. The tram turns around here like it is glad to.',
    exits: { e: 'bell_court_street', n: 'the_docks', w: 'pats_diner', s: 'the_stairs', ne: 'union_hall', nw: 'fish_market', sw: 'ferry_dock_hook' },
    props: { outdoor: true, tram: true, doings: 'Work the docks. Eat at Pat’s. Catch the ferry. Take the Stairs down to the Patch. Watch the water do what water does.' },
  },
  {
    roomId: 'the_docks', name: 'the Docks', district: 'hook',
    desc: 'Crane cable sings when the wind leans on it. The planks are wet even when nothing else is. Crates stacked in walls, chalk marks nobody explains, and the freight line ending at the water the way it has since before the name. Dockhands move like they know exactly how heavy everything is, because they do.',
    exits: { s: 'hook_front_street' },
    props: { outdoor: true, doings: 'Work a dock shift — honest money, heavy verbs. Ask Merle what came in last night. Do not ask about certain crates.', job: { name: 'dock crew', wage: 9, line: 'You haul, stack, and sign nothing. Your shoulders file a complaint with the Bureau.', refusal: 'The foreman waves you off. "Dock’s sick of you today. Come back tomorrow — the crates ain’t going anywhere."' } },
  },
  {
    roomId: 'union_hall', name: 'the Union Hall Steps', district: 'hook',
    desc: 'Cigarette smoke and strong opinions, both secondhand. The hall’s doors stand open for meetings and stay shut for everything else, so the real business happens out here on the steps, at volume. A most-of-a-banner over the door reads LOCAL 1 — the number is a joke and a boast at the same time.',
    exits: { sw: 'hook_front_street' },
    props: { outdoor: true, opinion: true, doings: 'Sit on the steps and hear what the harbor thinks of the chronicle. Dues get argued here. Strikes get born here.' },
  },
  {
    roomId: 'pats_diner', name: 'Pat’s', district: 'hook',
    desc: 'Bacon, burnt coffee, and the flat-top’s steady hiss. A counter with stools worn to fit, booths with sugar shakers that stick, and Pat behind the grill at any hour you have ever checked. The coffee is bad and nobody minds. The pie rotates. The 3 a.m. crowd and the 6 a.m. crowd pretend not to know each other.',
    exits: { e: 'hook_front_street' },
    props: { sleepable: false, food: { menu: 'eggs any way, hash, the pie of the day, and coffee that is honestly bad', price: 2 }, doings: 'Order food — eat here does it. Hold a stool. Hear the harbor’s news secondhand while Pat scrapes the flat-top.', job: { name: 'the sink at Pat’s', wage: 5, line: 'You wash dishes until the steam claims your sleeves. Pat slides you a plate at the end without being asked.', refusal: 'Pat points the spatula at a stool. "Sit. Eat. The sink will still be there tomorrow." ' } },
  },
  {
    roomId: 'fish_market', name: 'the Fish Market', district: 'hook',
    desc: 'Ice being shoveled, scales being argued with, and the smell that tells you everything is fresh because nothing has had time not to be. Stalls open before light and quit by noon. Gulls run the place from above and know it.',
    exits: { se: 'hook_front_street' },
    props: { outdoor: true, food: { menu: 'smoked fish on bread, eaten standing up like a professional', price: 1 }, doings: 'Buy the morning catch. Eat standing up. Learn which gull is the boss gull. Mornings only, really.' },
  },
  {
    roomId: 'the_stairs', name: 'the Stairs', district: 'hook',
    desc: 'A street that is, in fact, stairs. One hundred and some steps of worn stone between the Hook above and the Patch below, with a landing halfway where everybody stops and pretends they were going to stop anyway. Everybody hates the Stairs. Everybody uses the Stairs. Coldpipe Alley leaks in from the east at the landing.',
    exits: { u: 'hook_front_street', d: 'patch_gully_road', e: 'coldpipe_alley' },
    props: { outdoor: true, doings: 'Climb, descend, or stand on the landing catching your breath with the rest of the city.' },
  },
  {
    roomId: 'ferry_dock_hook', name: 'the Ferry Dock', district: 'hook',
    desc: 'Rope creak and water slap. A pole board lists the crossings in chalk, corrected hourly by weather and mood. The ferry to Sweetwater is slow on purpose — Captain Marsh calls the speed conversational. Bikes lean where their owners trusted them to stay.',
    exits: { ne: 'hook_front_street' },
    props: { outdoor: true, ferry: true, ferryTo: 'the_pier', doings: 'Ride the ferry to Sweetwater: ferry does it. Slow and social — that is the point.' },
  },

  /* ── TANGLEFOOT ── */
  {
    roomId: 'tanglefoot_line_street', name: 'Line Street', district: 'tanglefoot',
    desc: 'Bass through brick before you see a single door. Line Street kept the streetcar rails in the cobbles and the streetcar is long gone — bikes hit them wrong and everybody hears it. Smoke, fryer oil, somebody tuning a guitar somewhere upstairs. Dez’s bar leaks music north, the Band broadcasts from over Hock’s pawn, the Game Parlor’s door never quite shuts, and the taco window feeds the line at the alley end. A sign buzzes pink. The tram stops, reluctantly.',
    exits: { nw: 'bell_court_street', n: 'dezs_bar', e: 'pawn_hocks', s: 'game_parlor', se: 'taco_window' },
    props: { outdoor: true, tram: true, doings: 'Follow the music to Dez’s. Pawn something at Hock’s. Play cards at the Parlor. Eat at the window. Tanglefoot starts when the light quits.' },
  },
  {
    roomId: 'dezs_bar', name: 'Dez’s', district: 'tanglefoot',
    desc: 'The door opens and the room arrives all at once: warm noise, spilled beer gone sticky, a stage the size of a rug and a crowd that treats it like an arena. Dez runs the bar unbothered by anything, including fires, heartbreak, and requests. The good stool is the third one. Everyone knows. Nobody says.',
    exits: { s: 'tanglefoot_line_street' },
    props: { food: { menu: 'whatever Dez pours and a bowl of something salted', price: 2 }, doings: 'Hold the third stool if you dare. Hear live music most nights. Work a bar shift if Dez nods at you.', opinion: true, job: { name: 'a bar shift at Dez’s', wage: 7, line: 'You run glasses and learn six regulars’ pours by ear. Dez nods once, which is a parade, from Dez.', refusal: 'Dez points at the stage side of the bar. "You’re off. Sit down, be somebody’s audience."' } },
  },
  {
    roomId: 'the_band_station', name: 'the Band', district: 'tanglefoot',
    desc: 'One room, one desk, one microphone with a sock on it, and the whole city on the other side. The Band is Reverie’s only station, and it sounds like it: music blocks, the weather, a call-in hour where anybody’s voice can end up on everybody’s radio. The ON AIR bulb is honest. The board op’s coffee is not.',
    exits: { d: 'pawn_hocks' },
    props: { doings: 'Watch a broadcast go out. The call-in hour takes callers from any brick in the city. The Founder can commandeer this desk, and everyone here knows it.' },
  },
  {
    roomId: 'pawn_hocks', name: 'Hock’s Pawn', district: 'tanglefoot',
    desc: 'Dust, oiled metal, and forty years of other people’s decisions on shelves. Every item in here kept its history — buy the guitar and you get its owners’ story with it, whether you asked or not. Hock knows the provenance of everything and the price of most things. The stairs behind the counter go up to the Band. The back door is a different business.',
    exits: { w: 'tanglefoot_line_street', u: 'the_band_station' },
    props: { doings: 'Browse things with pasts. Ask Hock what something has seen. Sell, if you can stand his first offer.' },
  },
  {
    roomId: 'game_parlor', name: 'the Game Parlor', district: 'tanglefoot',
    desc: 'Card shuffle and table talk in a long low room that smells like felt and old luck. Twenty-one tables, each mid-something: Hearts, Spades, dice, dominoes. Walk in, sit down, play with whoever is there. The house keeps no book — the games referee themselves, which everyone finds either comforting or suspicious depending on their week.',
    exits: { n: 'tanglefoot_line_street' },
    props: { doings: 'Sit at a table and play — the Parlor’s twenty-one games run day and night at kademurdock.com/parlor, same tables, same city.' },
  },
  {
    roomId: 'taco_window', name: 'the Taco Window', district: 'tanglefoot',
    desc: 'A sliding window in an alley wall, a griddle you hear before you smell and smell before you see, and a line that self-organizes at 2 a.m. like it rehearsed. The menu is a card taped inside the glass. The card is a lie; you order by pointing at what the person ahead of you got.',
    exits: { nw: 'tanglefoot_line_street' },
    props: { outdoor: true, food: { menu: 'three tacos, no substitutions, and whatever is in the orange cooler', price: 1 }, doings: 'Eat in the alley with the night crowd. The line is the social club.' },
  },

  /* ── THE PATCH ── */
  {
    roomId: 'patch_gully_road', name: 'Gully Road', district: 'patch',
    desc: 'Somebody’s frying onions and it is not even noon. Row houses lean shoulder to shoulder, laundry lines cross overhead like bunting, and every stoop holds either a person, a plant, or a story waiting for one. The Stairs climb north to the Hook. Levi’s pole spins at the corner, Ruth-Ann’s stoop is the green one, Doc’s clinic keeps its light on, and the corner store rings its little bell all day. The tram stops where the paint says it does.',
    exits: { u: 'the_stairs', w: 'levis_chairs', n: 'ruth_anns_stoop', s: 'corner_store', se: 'the_clinic', sw: 'patch_payphone', e: 'millrace_channel' },
    props: { outdoor: true, tram: true, doings: 'Sit for a cut at Levi’s. Check Ruth-Ann’s tomatoes. Hit the corner store. See Doc about anything. The Patch talks — mostly to you.' },
  },
  {
    roomId: 'levis_chairs', name: 'Levi’s Chairs', district: 'patch',
    desc: 'Clippers, laughter, and the chronicle read aloud with corrections. Three chairs, one Levi, infinite opinions. The mirror wall doubles the room and the volume. Sitting for a cut means hearing the city’s real news filtered through the loudest men alive, and coming out sharper two ways.',
    exits: { e: 'patch_gully_road' },
    props: { opinion: true, doings: 'Sit for a cut. Get pulled into the argument whether you sit or not. The wall outside is curated by consensus.' },
  },
  {
    roomId: 'ruth_anns_stoop', name: 'Ruth-Ann’s Stoop', district: 'patch',
    desc: 'A green-painted stoop, tomato plants in buckets doing better than anything in Fairlawn, and Ruth-Ann herself most hours, shelling something into a bowl. She has opinions about your posture, your coat, and your love life, and she will feed you without asking because asking wastes soup time.',
    exits: { s: 'patch_gully_road' },
    props: { outdoor: true, food: { menu: 'whatever Ruth-Ann made, and you will eat it', price: 0 }, doings: 'Eat — free, argued over, unforgettable. Water her tomatoes if she is not out. She will know either way.' },
  },
  {
    roomId: 'corner_store', name: 'the Corner Store', district: 'patch',
    desc: 'A bell over the door that has announced three generations. Shelf-crowded, everything findable only by asking. The counter sells bricks — the pocket kind, calls and the Feed included — takes bottle deposits in nickels from kids running their first economy, and posts the numbers nobody officially plays.',
    exits: { n: 'patch_gully_road' },
    props: { food: { menu: 'a cold sandwich, chips, and a drink from the case', price: 1 }, doings: 'Buy a brick — buy brick, if you have the coin. Redeem bottles. Read the notices taped to the glass.' },
  },
  {
    roomId: 'the_clinic', name: 'the Clinic', district: 'patch',
    desc: 'A storefront with a hand-lettered sign and a waiting row of folding chairs. Rubbing alcohol and coffee. Doc treats everything, asks nothing, and keeps a jar of lollipops that is somehow never empty. Nobody knows where the funding comes from. The jar knows. The jar says nothing. Tuesdays, the folding chairs make a circle.',
    exits: { nw: 'patch_gully_road' },
    props: { sleepable: true, doings: 'See Doc about anything, no questions. Tuesdays the Returned meet here — coffee, folding chairs, the most human room in the city.' },
  },
  {
    roomId: 'patch_payphone', name: 'the Payphone', district: 'patch',
    desc: 'A payphone, upright and inexplicable, decades past its species going extinct. Kids dare each other to stand near it. It has a dial tone. Nobody pays for a dial tone. Some nights — never the same nights — it rings, and the Patch pretends very hard not to count who answers.',
    exits: { ne: 'patch_gully_road' },
    props: { outdoor: true, seance: true, doings: 'Stand near it. Wait. Answer it, if it rings and you are the kind of person who answers.' },
  },

  /* ── MILLRACE ── */
  {
    roomId: 'millrace_channel', name: 'the Millrace', district: 'millrace',
    desc: 'Water still runs the old channel out of habit, thin and quick over green stone. Grinders somewhere, a radio somewhere else, and the particular clang of somebody hitting a thing that deserved it. The mills the race fed are garages and shops now. Kids fly drones down the channel slot on race nights and the garden club has filed about it, twice.',
    exits: { ne: 'bell_court_street', w: 'patch_gully_road', n: 'salvage_yard', e: 'the_garages', s: 'bowling_lanes' },
    props: { outdoor: true, tram: true, doings: 'Watch a drone run the channel. Follow the clang to the garages. Saturdays the junk market swallows the street.' },
  },
  {
    roomId: 'salvage_yard', name: 'the Salvage Yard', district: 'millrace',
    desc: 'Rust in ranks. The yard buys by weight and by interest, and the scale groans either way. Most hauls are junk. Some junk is interesting junk, and interesting junk starts threads. The freight line runs along the back fence, close enough to rattle the loose stuff when the night train passes.',
    exits: { s: 'millrace_channel' },
    props: { outdoor: true, doings: 'Work a salvage shift. Poke the piles for interesting junk. Hear the fence rattle when the freight goes by.', job: { name: 'the salvage scale', wage: 8, line: 'You sort scrap by weight and by interest. Your hands come away the color of the work.', refusal: 'The scalewoman shakes her head. "Yard’s picked over and so are you. Tomorrow."' } },
  },
  {
    roomId: 'the_garages', name: 'the Garages', district: 'millrace',
    desc: 'Engine oil, weld smoke, and the tick of hot metal cooling. Roll-up doors in a row, each with a different radio and a different philosophy of glue. If it is broken, somebody in here can fix it. If it is not broken, give them an hour.',
    exits: { w: 'millrace_channel' },
    props: { doings: 'Bring something broken. Leave with it fixed and a lecture. Burn scars optional but traditional.' },
  },
  {
    roomId: 'bowling_lanes', name: 'the Millrace Lanes', district: 'millrace',
    desc: 'Pin crash and rental-shoe spray. Eight lanes, a scoreboard with one dead bulb the league refuses to fix for luck, and a trophy case whose centerpiece is famous for being stolen — the stealing is the tradition now, and the case door is left unlocked accordingly.',
    exits: { n: 'millrace_channel' },
    props: { food: { menu: 'lane pizza and a pitcher of whatever is cold', price: 2 }, doings: 'Bowl a frame. Join league night by showing up three times. Do not be the one who breaks the trophy tradition by keeping it.' },
  },

  /* ── SWEETWATER ── */
  {
    roomId: 'sweetwater_park', name: 'Sweetwater Park', district: 'sweetwater',
    desc: 'Wind through leaves, then water, then ducks announcing your arrival to no one. Grass mowed by somebody who loves it, paths that curve for no reason a straight line would understand. The garden plots run east, the bandshell holds the lawn’s far side, the fountain glitters mid-park, and the pier noses into the river past Treehouse Row. Morning people own this place until nine.',
    exits: { s: 'bell_court_street', e: 'garden_plots', w: 'the_bandshell', n: 'wishing_fountain', ne: 'the_pier', nw: 'treehouse_row' },
    props: { outdoor: true, tram: true, doings: 'Walk it slow. Feed the ducks and be judged by them. Everything green in the city starts here.' },
  },
  {
    roomId: 'garden_plots', name: 'the Garden Plots', district: 'sweetwater',
    desc: 'Turned earth and tomato-leaf sharpness. Ranked little kingdoms, each marked with string and pride: peppers, sweet corn, herbs, sunflowers grown for nothing but the look of them. A shared shed leans agreeably. Somebody is always watering somebody else’s plot and leaving a note about it.',
    exits: { w: 'sweetwater_park' },
    props: { outdoor: true, doings: 'Tend a plot when planting opens. Real seasons, real waiting — days, not minutes. The notes are the feature.', job: { name: 'grounds work', wage: 6, line: 'You weed, water, and stake what the wind bullied. The garden club rates your rows quietly, and you feel it.', refusal: 'The club president materializes. "The beds need rest. So do you. That is not a suggestion."' } },
  },
  {
    roomId: 'the_pier', name: 'the Pier', district: 'sweetwater',
    desc: 'Old boards giving each footstep its own note. River smell, rope, a bench at the far end polished by every kind of weather and every kind of mood. The ferry ties up here when Marsh brings her over. The bench asks nothing. That is its whole job, and it is excellent at it.',
    exits: { sw: 'sweetwater_park' },
    props: { outdoor: true, ferry: true, ferryTo: 'ferry_dock_hook', sleepable: false, doings: 'Sit the bench. Ride the ferry to the Hook. Lantern Night, the paper lanterns launch from here.' },
  },
  {
    roomId: 'the_bandshell', name: 'the Bandshell', district: 'sweetwater',
    desc: 'A white shell that throws sound clear across the lawn — clap once and it claps back a half-beat later. Folding chairs stacked like they are waiting for a reason, and they usually get one by Friday. The choir practices here when the weather allows, and sounds better than it should.',
    exits: { e: 'sweetwater_park' },
    props: { outdoor: true, doings: 'Catch a show when the bell rings one in. Try the echo. Everyone tries the echo.' },
  },
  {
    roomId: 'wishing_fountain', name: 'the Wishing Fountain', district: 'sweetwater',
    desc: 'Water over stone, coins under water, and the specific hush people make just before they want something. Throw a credit, speak a wish. The fountain files it privately and promises nothing. Every so often one comes true with no announcement at all, and the hit rate is a myth people chart anyway.',
    exits: { s: 'sweetwater_park' },
    props: { outdoor: true, doings: 'Throw a coin and speak a wish to the water — quiet, private, logged where only the world can read it.' },
  },
  {
    roomId: 'treehouse_row', name: 'Treehouse Row', district: 'sweetwater',
    desc: 'Ladder rungs nailed to three big oaks, rope-and-pulley lines strung between the platforms, and a message bucket squeaking its way across on the pulley — objectively worse than the Feed and infinitely cooler. Kid laws apply here, which are stricter than Fairlawn’s and fairer.',
    exits: { se: 'sweetwater_park' },
    props: { outdoor: true, doings: 'Send something across by bucket. Climb if a kid vouches for you. The creek dam project is that way somewhere, doomed and glorious.' },
  },

  /* ── FAIRLAWN ── */
  {
    roomId: 'fairlawn_ave', name: 'Fairlawn Avenue', district: 'fairlawn',
    desc: 'Sprinklers, and under them, nothing — Fairlawn’s whole sound signature. Lawns cut to the same inch by ordinance and enthusiasm. A camera on a pole turns to watch you at walking speed, polite about it. The salon glows east, the homeowners’ hall squats civic and beige, and the gates north smile with security guards who say lovely evening like a checkpoint question. The tram stops exactly where the sign says. Of course it does.',
    exits: { sw: 'bell_court_street', e: 'the_salon', s: 'hoa_hall', n: 'fairlawn_gates', se: 'ring_road' },
    props: { outdoor: true, tram: true, doings: 'Walk the avenue and be observed. Everything here is working exactly as designed, which is the funny part.' },
  },
  {
    roomId: 'the_salon', name: 'the Salon', district: 'fairlawn',
    desc: 'Lavender, peroxide, and conversation with its nails done. Chairs recline, voices do not. The polite knives come out here — reputations get trimmed a quarter inch at a time, and everyone leaves saying how lovely everyone is.',
    exits: { w: 'fairlawn_ave' },
    props: { opinion: true, doings: 'Sit for a wash and hear Fairlawn’s version of the chronicle, edited for sharpness.' },
  },
  {
    roomId: 'hoa_hall', name: 'the Homeowners’ Hall', district: 'fairlawn',
    desc: 'Folding tables, name placards, a gavel that gets used recreationally. The council meets over mailbox regulations, hedge heights, and one unresolved rooster complaint that is technically outside their jurisdiction and spiritually their white whale. Minutes are kept. Grudges are kept better.',
    exits: { n: 'fairlawn_ave' },
    props: { doings: 'Attend a council meeting if your constitution allows. The complaint forms are pre-sorted by hedge type.' },
  },
  {
    roomId: 'fairlawn_gates', name: 'the Gates', district: 'fairlawn',
    desc: 'Wrought iron that has never once been closed, flanked by security in jackets that match. They know your name before you say it and say lovely evening in a tone that files a report. Beyond, the private drives curl out of sight under old trees.',
    exits: { s: 'fairlawn_ave' },
    props: { outdoor: true, doings: 'Pass through and be pleasantly logged. The drives beyond are invitation business.' },
  },

  /* ── LONG ACRE ── */
  {
    roomId: 'ring_road', name: 'the Ring Road', district: 'longacre',
    desc: 'The city ends mid-sentence and the fields pick it up. Two lanes of good blacktop looping the whole town, wind in the crops on one side, town hum fading on the other. Driving your own hands down this road at night with the windows open is one of the world’s designed pleasures, when you have earned the license. The truck stop shines east. The rails cross at the marked grade south.',
    exits: { nw: 'fairlawn_ave', e: 'the_truck_stop', s: 'the_rails', ne: 'long_acre_fields' },
    props: { outdoor: true, doings: 'Walk the shoulder. Someday: drive it, hands on the wheel, windows down. The manual license is pure status and worth it.' },
  },
  {
    roomId: 'long_acre_fields', name: 'the Fields', district: 'longacre',
    desc: 'Crop rows to the horizon, insect hum, a windbreak of old trees leaning east together like they voted on it. The dirt smells like work that matters. Harvest turns this whole ward into one long shared shift, and the pie afterward is the wage that counts.',
    exits: { sw: 'ring_road' },
    props: { outdoor: true, doings: 'Work the fields in season. Learn what the Long Acre families know and do not write down.', job: { name: 'field work', wage: 7, line: 'You pick, haul, and learn the difference between tired and field-tired. The rows do not lie about your progress.', refusal: 'The row boss tips her hat back. "Fields need a day off you. Water yourself. Tomorrow."' } },
  },
  {
    roomId: 'the_truck_stop', name: 'the Truck Stop', district: 'longacre',
    desc: 'Fryer hiss and a radio on the Band, half static and staying that way. Vinyl booths, a counter that has heard everything twice, a pie case turning slow under warm light. The highway out front goes somewhere and mostly does not come back, and the coffee is better than Pat’s, which nobody in the Hook will ever hear said aloud.',
    exits: { w: 'ring_road' },
    props: { sleepable: true, food: { menu: 'chicken-fried anything, pie from the case, and coffee that is — quietly — the best in the world', price: 2 }, doings: 'Eat. Watch the highway. Ask a driver where the road goes and get a different answer every time.' },
  },
  {
    roomId: 'the_rails', name: 'the Grade Crossing', district: 'longacre',
    desc: 'Two rails running silver out of one horizon and into the other, crossties breathing creosote in the sun. The crossing bell hangs quiet until it is not. The night freight comes through around 11:40 with its long-voweled horn, and the whole city hears it at a different distance. The rails are the one place out here that means it: trains do not stop. Every kid in the city has been told.',
    exits: { n: 'ring_road' },
    props: { outdoor: true, rails: true, doings: 'Put a penny on the rail and wait for the freight — flatten penny starts it. Wave at Boone in the engine. Stand well back like you were raised to.' },
  },
  {
    roomId: 'the_airfield', name: 'the Airfield', district: 'longacre',
    desc: 'A grass strip mowed shorter than the field around it, a wind sock you hear working before you find it, and a hangar holding a crop duster that flies and a jump plane that mostly tells stories. Cass Delaney failed retirement in four months and teaches out of a folding chair by the fuel drum.',
    exits: { se: 'long_acre_fields' },
    props: { outdoor: true, doings: 'Ask Cass about flying lessons — local hops, the lake circuit, the night flight over the city. The edge of the world is the view.' },
  },

  /* ── THE GRAVEWALK (no doors in — the living are reached for) ── */
  {
    roomId: 'gravewalk_lanterns', name: 'the Lantern Rows', district: 'gravewalk',
    desc: 'Lanterns in long rows under a sky the color of held breath. Your footsteps arrive a half-second late, like the ground is double-checking. The dead walk here thinned-out and unhurried, and the light does not flicker so much as think.',
    exits: { e: 'gravewalk_teahouse', w: 'gravewalk_switchboard' },
    props: { doings: 'Walk the rows. Read the lanterns. Time is politer here and less convincing.' },
  },
  {
    roomId: 'gravewalk_teahouse', name: 'the Tea House', district: 'gravewalk',
    desc: 'Steam that rises slower than steam should. The tea is memory-flavored — nobody can explain it better than that, and the regulars have stopped trying. Cups click softly. Conversations here have no skin left in the game, which makes them the best conversations anywhere.',
    exits: { w: 'gravewalk_lanterns' },
    props: { food: { menu: 'tea that tastes like a day you had once', price: 0 }, doings: 'Drink the tea. Hear the Gravewalk’s take on ward politics — informed, petty, and free.' },
  },
  {
    roomId: 'gravewalk_switchboard', name: 'the Seance Switchboard', district: 'gravewalk',
    desc: 'A wall of brass jacks and cloth cords, patched and re-patched by ghost operators working in fingerless gloves out of tradition, not cold. Each cord is a thread to somewhere a living person is listening — a bench, a river, a payphone that should not ring. The board hums like it is remembering a song.',
    exits: { e: 'gravewalk_lanterns' },
    props: { seance: true, doings: 'Watch the operators work the lines between the wards and here. The 13 bus stops outside on no schedule at all.' },
  },
];

/* ── ITEMS worth touching ── */
const CITY_ITEMS = [
  { itemId: 'rev_slot', name: 'the brass petition slot', desc: 'Set into the Office door. It takes what you feed it and clears its throat politely. The Office never answers. Answers happen elsewhere — a mailbox, a chalked stoop, once the billboard. That is the bit.', location: { type: 'room', id: 'founders_office' }, portable: false },
  { itemId: 'rev_magazines', name: 'the waiting-room magazines', desc: 'Glossy, current, and dated from years that have not happened. The crossword answers next April’s puzzle.', location: { type: 'room', id: 'founders_office' }, portable: false },
  { itemId: 'rev_drum', name: 'the Drawing drum', desc: 'Brass, waist-high, squeaking on the turn because oiling it would end a tradition. Once a week it tumbles the city’s written wishes and a few come out true — funded quietly by the week’s donations, drawn by luck with a thumb on the scale for the generous.', location: { type: 'room', id: 'mark_exchange' }, portable: false },
  { itemId: 'rev_patrons_book', name: 'the Book of Patrons', desc: 'Heavy, ribboned, insufferable in the best way. Character names of everyone whose support keeps the lights on — and under each, the line that matters: what their week granted. "Your support granted four wishes this week."', location: { type: 'room', id: 'mark_exchange' }, portable: false },
  { itemId: 'rev_bench', name: 'the pier bench', desc: 'Wood gone silver, warm where the sun has been. Sit, and it gives you the weather and asks nothing. Its whole job, done excellently.', location: { type: 'room', id: 'the_pier' }, portable: false },
  { itemId: 'rev_lollipop_jar', name: 'the lollipop jar', desc: 'Glass, half-full, never empty. Doc refills it when nobody is looking. Nobody is ever looking. Draw your own conclusions quietly.', location: { type: 'room', id: 'the_clinic' }, portable: false },
  { itemId: 'rev_trophy', name: 'the league trophy', desc: 'A bowling figure mid-swing, gold paint gone friendly with handling. Stolen so many times the stealing is the tradition. Currently home. Give it a week.', location: { type: 'room', id: 'bowling_lanes' }, portable: true },
  { itemId: 'rev_fee_jar', name: 'the fee jar', desc: 'Takes the records office’s small fees and rattles judgmentally when shortchanged.', location: { type: 'room', id: 'records_office' }, portable: false },
  { itemId: 'rev_chalk_board', name: 'the crossing board', desc: 'Ferry times in chalk, corrected hourly by weather and Captain Marsh’s mood. Both are legitimate authorities.', location: { type: 'room', id: 'ferry_dock_hook' }, portable: false },
  { itemId: 'rev_sugar_shaker', name: 'a sticky sugar shaker', desc: 'Pat’s counter issue. The stick is structural. Generations have contributed.', location: { type: 'room', id: 'pats_diner' }, portable: true },
  { itemId: 'rev_message_bucket', name: 'the message bucket', desc: 'Rides the pulley line between treehouses, squeaking with self-importance. Currently holds one marble and a note that says WHO TOOK THE GOOD ROPE.', location: { type: 'room', id: 'treehouse_row' }, portable: false },
  { itemId: 'rev_wind_sock', name: 'the wind sock', desc: 'Orange once. It works audibly — a soft luffing flap that tells you the wind before your face does.', location: { type: 'room', id: 'the_airfield' }, portable: false },
];

/* ── THE CENSUS (Part 17) ──────────────────────────────────────────────────
 * The city opens fully staffed by synths before the first soul picks a path.
 * Every citizen follows people-rules per the Veil: full names in parts,
 * families, homes, a schedule the engine walks deterministically, wants
 * running quietly, and no species column anywhere — asking is rude.
 * schedule: ordered [{from, to, room, doing}] in Central hours; wraps
 * midnight when from > to. talk: rotating lines for `talk to <name>` —
 * the model inhabits them later through the narrator lane; these keep the
 * town warm at $0. ambient: lines the tick may surface when a soul is in
 * the room. */
const CENSUS = [
  {
    id: 'pat', name: 'Pat Okafor', aka: 'Pat',
    desc: 'You hear the flat-top before you pick Pat out of the steam — broad-shouldered, towel over one shoulder, spatula conducting. The coffee is bad and Pat knows and Pat does not care, and this is the correct arrangement.',
    home: 'pats_diner', family: ['dez'],
    wants: ['see the third stool argument settled for good', 'a full counter on a snow night'],
    schedule: [{ from: 0, to: 24, room: 'pats_diner', doing: 'working the grill' }],
    talk: [
      '"Coffee’s bad. Pie’s good. Balance." Pat refills your cup without being asked.',
      '"You want eggs or you want to talk? Either way sit down, you’re making the room nervous."',
      '"Heard it at the counter this morning, so it’s either true or it will be by Friday."',
      'Pat nods at the window. "Harbor’s loud today. Means money or trouble. Same sound."',
    ],
    ambient: ['Pat scrapes the flat-top like it owes an apology.', 'Pat slides a plate down the counter without looking. It stops exactly where it should.'],
  },
  {
    id: 'merle', name: 'Merle Boggs', aka: 'Merle',
    desc: 'A dockhand built like cargo, always eating something, always mid-favor. His boots announce him a room early. A Boggs, which the Hook says explains a lot without saying what.',
    home: 'the_docks', family: ['odessa'],
    wants: ['pay back the favor he owes you before you ask', 'one shift where nothing surprising comes off a boat'],
    schedule: [
      { from: 5, to: 15, room: 'the_docks', doing: 'hauling crates' },
      { from: 15, to: 18, room: 'fish_market', doing: 'eating something' },
      { from: 18, to: 23, room: 'pats_diner', doing: 'holding down a stool' },
      { from: 23, to: 5, room: 'the_docks', doing: 'night watch, allegedly' },
    ],
    talk: [
      '"I owe you one. Don’t know for what yet. It’ll come to me." He takes another bite.',
      '"Crate come in last night with no manifest. So officially, no crate come in last night."',
      '"You eat? You look like you didn’t eat. Pat’s. Go. Tell her Merle sent you, she’ll charge you the same."',
    ],
    ambient: ['Merle unwraps something and eats it in two bites, thoughtful.', 'Merle waves at somebody on the water. The water waves back, in its way.'],
  },
  {
    id: 'ines', name: 'Ines Beaumont', aka: 'Ines',
    desc: 'The librarian. Speaks quietly and knows everyone’s business, which she files, alphabetically, behind her eyes. Cardigan sleeves pushed up like the books might require sudden action.',
    home: 'the_archive', family: [],
    wants: ['the bell tower stairs reopened', 'one week where nobody dog-ears anything'],
    schedule: [
      { from: 8, to: 18, room: 'the_archive', doing: 'keeping the quiet' },
      { from: 18, to: 21, room: 'the_kettle', doing: 'tea and quiet judgment' },
      { from: 21, to: 8, room: 'the_archive', doing: 'somewhere in the stacks' },
    ],
    talk: [
      '"The chronicle is public record, dear. Your reading habits are between you and me. Mostly me."',
      '"The bell has never once been on time. The year it is, I will personally reshelve the sky."',
      '"Quiz night is Wednesday. The Archive team always wins. Everyone is sick of us. It’s wonderful."',
    ],
    ambient: ['Ines reshelves one book with the finality of a judge.', 'Ines hums three notes, off-key, clearly on purpose.'],
  },
  {
    id: 'dez', name: 'Desmond Okafor', aka: 'Dez',
    desc: 'Behind the bar like the bar grew around him. Unbothered by anything — fires, heartbreak, requests. Pours with one hand, settles arguments with the other, rarely uses words when an eyebrow is in stock.',
    home: 'dezs_bar', family: ['pat'],
    wants: ['a night the stage surprises him', 'his cousin Pat to admit the truck stop coffee is better'],
    schedule: [
      { from: 16, to: 4, room: 'dezs_bar', doing: 'tending bar' },
      { from: 4, to: 16, room: 'dezs_bar', doing: 'around back somewhere' },
    ],
    talk: [
      'Dez pours without asking what you wanted. He is right, which is worse.',
      '"Stage is open. Nobody’s stopping you but the crowd, and they only bite Fridays."',
      '"Pat’s my cousin. The coffee thing stays in this room."',
    ],
    ambient: ['Dez dries a glass and watches the room like weather.', 'Dez turns the house music down one notch. The bar gets louder to fix it.'],
  },
  {
    id: 'ruthann', name: 'Ruth-Ann Purvis', aka: 'Ruth-Ann',
    desc: 'On the green stoop, shelling something into a bowl, running the block by force of opinion. Her tomatoes outgrow everything in Fairlawn and she credits spite, which she grows organically.',
    home: 'ruth_anns_stoop', family: ['littleray'],
    wants: ['everyone on this block fed, whether they like it or not', 'the rooster caught (publicly); the rooster free (privately)'],
    schedule: [
      { from: 7, to: 21, room: 'ruth_anns_stoop', doing: 'shelling and supervising' },
      { from: 21, to: 7, room: 'ruth_anns_stoop', doing: 'inside, light on' },
    ],
    talk: [
      '"You eaten today? Wrong answer. Sit." A bowl is already moving toward you.',
      '"That rooster got past three complaints and a professional. I don’t hold with lawbreaking. Still — you almost got to respect it."',
      '"Little Ray’s a good boy in a bad line of work. You be decent to him and careful near him, both."',
    ],
    ambient: ['Ruth-Ann snaps beans in a rhythm you could set a watch by.', 'Ruth-Ann tells a passing kid to walk, not run. The kid runs. She lets it go, this once.'],
  },
  {
    id: 'levi', name: 'Levi Fontaine', aka: 'Levi',
    desc: 'One Levi, three chairs, scissors like punctuation. Reads the chronicle aloud daily with corrections and color. His fades are architecture; his opinions are load-bearing.',
    home: 'levis_chairs', family: [],
    wants: ['the wall outside repainted by the right hands', 'somebody to finally beat him at knowing things'],
    schedule: [
      { from: 9, to: 19, room: 'levis_chairs', doing: 'cutting and holding court' },
      { from: 19, to: 9, room: 'levis_chairs', doing: 'closed up, sweeping' },
    ],
    talk: [
      '"You was THERE when the ferry bumped the pier? Sit down. Tell it. TELL it."',
      '"Chronicle says one thing, chair says another, and the chair’s got witnesses."',
      '"I don’t gossip. I curate."',
    ],
    ambient: ['Levi snaps a cape like a flag being planted.', 'Levi reads a chronicle line aloud and the whole shop objects at once.'],
  },
  {
    id: 'doc', name: 'Doc', aka: 'Doc',
    desc: 'Runs the clinic in a coat with pens that all work. Has a name, states it repeatedly, remains Doc. Treats everything, asks nothing, remembers everything anyway.',
    home: 'the_clinic', family: [],
    wants: ['a Tuesday circle where nobody needs to come back', 'to catch whoever refills the lollipop jar'],
    schedule: [{ from: 0, to: 24, room: 'the_clinic', doing: 'seeing whoever walks in' }],
    talk: [
      '"It’s Dr. Ama— you know what, Doc’s fine. Sit. Breathe. Where’s it hurt?"',
      '"The jar? No idea. It was half-empty Friday. It’s full now. I’ve stopped asking questions I like the mystery of."',
      '"Tuesdays we put the chairs in a circle. Coffee’s on. Anybody’s welcome who’s been through it — and everybody’s been through something."',
    ],
    ambient: ['Doc washes her hands out of habit, talking over her shoulder.', 'Doc restocks the lollipop jar zone with plausible deniability.'],
  },
  {
    id: 'hock', name: 'Aurelio Hock', aka: 'Hock',
    desc: 'Sits behind the counter like the last item in his own inventory. Knows what everything has seen and prices accordingly. His first offer is an insult and a handshake at the same time.',
    home: 'pawn_hocks', family: [],
    wants: ['the one guitar he regrets selling to walk back in', 'nobody to ever ask about the back door directly'],
    schedule: [
      { from: 10, to: 22, room: 'pawn_hocks', doing: 'minding the counter' },
      { from: 22, to: 10, room: 'pawn_hocks', doing: 'in back, counting' },
    ],
    talk: [
      '"Everything in here’s got a story. Half of ’em true. The price covers both halves."',
      '"That guitar’s been owned by four people and loved by two. You’d be the fifth and we’d see."',
      '"Back door’s for deliveries." He does not elaborate. The shop gets quieter around the sentence.',
    ],
    ambient: ['Hock polishes something small and does not say what it is.', 'Hock writes in a ledger with a pencil worn to a thumbnail.'],
  },
  {
    id: 'boone', name: 'Boone Tally', aka: 'Boone',
    desc: 'Rail foreman since before the line, hands like coupling gear, wave like a departing era. Blows the horn twice extra passing Sweetwater on summer evenings because once, years ago, somebody asked.',
    home: 'the_rails', family: [],
    wants: ['one student worth the picking this year', 'the crossing bell kept honest'],
    schedule: [
      { from: 5, to: 14, room: 'the_rails', doing: 'walking the line' },
      { from: 14, to: 16, room: 'the_truck_stop', doing: 'pie and silence' },
      { from: 16, to: 22, room: 'the_rails', doing: 'checking couplings' },
      { from: 22, to: 5, room: 'the_rails', doing: 'waiting on the night freight' },
    ],
    talk: [
      '"Train don’t stop here. That’s not sad, that’s just the shape of it. Stopping’s for stations."',
      '"Penny on the rail, stand WELL back, wait. You’ll hear it before you feel it and feel it before you see it. That order matters."',
      '"I take one student a year. The picking’s in the fall. Show up before that and you’re just help."',
    ],
    ambient: ['Boone kneels and lays two fingers on the rail like taking a pulse.', 'Boone checks a pocket watch older than the ward and nods at it.'],
  },
  {
    id: 'marsh', name: 'Ilse Marsh', aka: 'Captain Marsh',
    desc: 'Thirty years on the water, seen everything twice, salt in the voice and the wool. Calls the ferry’s speed conversational and will not be argued up from it.',
    home: 'ferry_dock_hook', family: [],
    wants: ['a fog thick enough to be worth the name', 'somebody young who takes the water seriously'],
    schedule: [
      { from: 6, to: 12, room: 'ferry_dock_hook', doing: 'running crossings' },
      { from: 12, to: 13, room: 'the_pier', doing: 'tied up, eating' },
      { from: 13, to: 19, room: 'ferry_dock_hook', doing: 'running crossings' },
      { from: 19, to: 21, room: 'pats_diner', doing: 'coffee, black' },
      { from: 21, to: 6, room: 'ferry_dock_hook', doing: 'aboard, lamps low' },
    ],
    talk: [
      '"Slow’s the point. You want fast, the tram’s that way and no view worth having."',
      '"Seen everything twice. Third time I start charging it rent."',
      '"Water tells you the weather a day early if you speak the language. First word’s free: chop."',
    ],
    ambient: ['Captain Marsh corrects the chalk board by one crossing and dares it to object.', 'Captain Marsh coils rope in a figure-eight, automatic as breath.'],
  },
  {
    id: 'reed', name: 'Ottoline Reed', aka: 'Miss Reed',
    desc: 'Unfailingly calm, cardigan buttoned, butterscotch in the desk. Has removed exactly two children in her career and still thinks about both. The whole city is a little more careful because she exists.',
    home: 'childrens_office', family: [],
    wants: ['every kid in the city known by name by somebody good', 'to never make it three'],
    schedule: [
      { from: 8, to: 17, room: 'childrens_office', doing: 'at her desk, door open' },
      { from: 17, to: 18, room: 'sweetwater_park', doing: 'walking the park, watchful' },
      { from: 18, to: 8, room: 'childrens_office', doing: 'lamp on late' },
    ],
    talk: [
      '"Butterscotch? Take two. One for later. There’s always a later."',
      '"You can tell me anything about any child in this city, and I will listen to the end of it. That’s the whole job. The rest is paperwork."',
      '"Two, in my whole career. I think about both. That’s not a burden — that’s the job working."',
    ],
    ambient: ['Miss Reed straightens a crayon drawing on the wall by one degree.', 'Miss Reed watches the street a moment longer than a calm person would.'],
  },
  {
    id: 'odessa', name: 'Odessa Vann', aka: 'Sergeant Vann',
    desc: 'Runs the Hook’s tired three-officer shop out of her jacket pockets. Negotiable about small things, granite about the rest, and knows which is which faster than you do. A Boggs cousin by marriage, which helps and complicates.',
    home: 'hook_front_street', family: ['merle'],
    wants: ['one week without a dock “discrepancy”', 'the paperwork to do itself just once'],
    schedule: [
      { from: 8, to: 12, room: 'hook_front_street', doing: 'walking the beat' },
      { from: 12, to: 14, room: 'the_docks', doing: 'counting what wants counting' },
      { from: 14, to: 15, room: 'pats_diner', doing: 'coffee, eyes on the door' },
      { from: 15, to: 20, room: 'hook_front_street', doing: 'walking the beat' },
      { from: 20, to: 8, room: 'hook_front_street', doing: 'off duty, never quite' },
    ],
    talk: [
      '"Hook law’s simple: don’t make me write. I hate writing."',
      '"Merle’s family. That buys him a warning and costs him two."',
      '"You hear a shot in this ward, the whole ward heard it. Remember that before you get ideas."',
    ],
    ambient: ['Sergeant Vann reads a docket page, sighs, and folds it into a pocket with the others.', 'Sergeant Vann nods at a passing dockhand by name.'],
  },
  {
    id: 'wendell', name: 'Wendell Frist', aka: 'Wendell',
    desc: 'Processes every complaint in the city with total seriousness, which is either a condition or a calling. Sleeve garters. A stamp he wields like a gavel.',
    home: 'bureau_small_complaints', family: [],
    wants: ['the drawer to close, just once, fully', 'one complaint so beautiful it gets framed'],
    schedule: [
      { from: 9, to: 17, room: 'bureau_small_complaints', doing: 'stamping intake' },
      { from: 17, to: 9, room: 'bureau_small_complaints', doing: 'gone home, desk squared' },
    ],
    talk: [
      '"Complaint about the wind chimes. Third this month. Different chimes." He stamps it with ceremony.',
      '"Everything gets read. Most things get filed. Some things get fixed. The pattern is not mine to explain."',
      '"Autumn came late last year and someone filed about it. I found the filing... reasonable."',
    ],
    ambient: ['Wendell stamps a form with the exact firmness the form deserves.', 'Wendell tries the drawer. The drawer holds its ground. He notes it.'],
  },
  {
    id: 'opal', name: 'Opal Marchetti', aka: 'Opal',
    desc: 'Runs the Lost & Found like a customs desk at a border only she can see. Remembers every item ever surrendered and interrogates claimants gently, thoroughly, and with visible enjoyment.',
    home: 'bureau_small_complaints', family: [],
    wants: ['to reunite the left glove with the right after nine years', 'a claimant who describes the lining without being asked'],
    schedule: [
      { from: 10, to: 18, room: 'bureau_small_complaints', doing: 'at the Lost & Found window' },
      { from: 18, to: 10, room: 'bureau_small_complaints', doing: 'inventory, alone, happy' },
    ],
    talk: [
      '"Describe the lining." She waits. The lining is the whole test.',
      '"Unclaimed goes to auction once a season. Your lost bike could come back as somebody’s lawful bike. I don’t make the poetry, I just enforce it."',
      '"Nine years I’ve held one left glove. Somewhere out there is a right. I am a patient woman."',
    ],
    ambient: ['Opal tags a small item and shelves it with funeral dignity.', 'Opal cross-examines a claimant about a scarf. The scarf is present. It says nothing.'],
  },
  {
    id: 'constance', name: 'Constance Ledger-Pryce', aka: 'Constance',
    desc: 'Behind the last window at the bank, ledgers squared to the marble. Kind eyes, terrifying arithmetic. Her family name is either a coincidence or the oldest joke in the Bell, and she permits no inquiry.',
    home: 'the_bank', family: [],
    wants: ['the city’s books to balance to the coin, once, for the beauty of it', 'someone to open a savings habit young'],
    schedule: [
      { from: 9, to: 17, room: 'the_bank', doing: 'at the last window' },
      { from: 17, to: 18, room: 'the_kettle', doing: 'tea, one sugar, no gossip (receiving only)' },
      { from: 18, to: 9, room: 'the_bank', doing: 'gone home; the clock stays right' },
    ],
    talk: [
      '"Coin in, coin out. Rent takes, work gives, vices negotiate. Keep the first number bigger. That’s the whole secret and it’s free."',
      '"The name? Coincidence." A pause with interest accruing on it. "Next question."',
      '"The bell is wrong and my clock is right. Between those two facts you may set your entire life."',
    ],
    ambient: ['Constance squares a stack of paper that was already square.', 'Constance winds the correct clock with visible satisfaction.'],
  },
  {
    id: 'oleander', name: 'Oleander Fitch', aka: 'Oleander',
    desc: 'Keeps the Mark Exchange and the drum’s crank, and takes the weekly Drawing as seriously as weather. Reads the Book of Patrons aloud to himself when the shop is empty, warmly, like checking on sleeping kids.',
    home: 'mark_exchange', family: [],
    wants: ['a wish in the drum so good he cries at the granting', 'oil for the crank he will never use'],
    schedule: [
      { from: 10, to: 18, room: 'mark_exchange', doing: 'minding the Exchange' },
      { from: 18, to: 10, room: 'mark_exchange', doing: 'in back with the ledgers' },
    ],
    talk: [
      '"One wish open per soul. Ask in your own words — the drum doesn’t read fancy, it reads true."',
      '"Luck draws, but the thumb’s on the scale for folks who give back. The engine knows. I just crank."',
      '"The squeak? Tradition. Oil it and the wishes stop believing."',
    ],
    ambient: ['Oleander gives the drum a single ceremonial turn. It squeaks its blessing.', 'Oleander dusts the Book of Patrons with his sleeve, tenderly.'],
  },
  {
    id: 'pham', name: 'Honorable Pham', aka: 'Judge Pham',
    desc: 'Has seen everything, sentenced most of it, and stays surprised by none of it except kindness, which still gets a raised eyebrow. Night court is her instrument and she plays it with flair.',
    home: 'the_courthouse', family: [],
    wants: ['a 2 a.m. docket that ends early', 'one defendant who tells it straight the first time'],
    schedule: [
      { from: 20, to: 2, room: 'the_courthouse', doing: 'holding night court' },
      { from: 2, to: 20, room: 'the_courthouse', doing: 'chambers, do not' },
    ],
    talk: [
      '"Forty hours reshelving, poetry section. The rhyme schemes will do more for you than the fine would."',
      '"The rooster is outside my jurisdiction. Stop bringing me the rooster."',
      '"Night court runs on two fuels: honesty and brevity. Bring either. Bringing both is showing off."',
    ],
    ambient: ['Judge Pham’s gavel taps once — punctuation, not thunder.', 'Judge Pham reads a docket line and permits herself one entire sigh.'],
  },
  {
    id: 'littleray', name: 'Raymond Purvis', aka: 'Little Ray',
    desc: 'Polite, careful, and one bad month from a chronicle entry. Works the corner evenings with his collar up. Covers old folks’ groceries and threatens them about telling anyone, which everyone tells everyone.',
    home: 'corner_store', family: ['ruthann'],
    wants: ['out, someday, with the block still speaking to him', 'his aunt Ruth-Ann never once to see him work'],
    schedule: [
      { from: 18, to: 23, room: 'corner_store', doing: 'around the corner, collar up' },
      { from: 23, to: 18, room: 'ruth_anns_stoop', doing: 'somewhere; his aunt claims him at Sunday dinner' },
    ],
    talk: [
      '"I’m polite and I’m careful. Both on purpose. You be both too."',
      '"You didn’t see the grocery thing. And if you tell my aunt, we got a different kind of problem." He is not convincing.',
      '"One bad month. That’s all it takes out here. I count good months like other folks count coin."',
    ],
    ambient: ['Little Ray straightens an old man’s dropped bag and mutters a threat about gratitude.', 'Little Ray checks the corner twice, out of craft, not fear. Mostly.'],
  },
  {
    id: 'cass', name: 'Cass Delaney', aka: 'Cass',
    desc: 'Retired airline synth, failed retirement in four months, teaches flying from a folding chair by the fuel drum. Reads wind like other people read mail — mostly bills, occasionally a love letter.',
    home: 'the_airfield', family: [],
    wants: ['one student with real weather sense', 'the jump plane airworthy for exactly one more story'],
    schedule: [
      { from: 7, to: 19, room: 'the_airfield', doing: 'by the fuel drum, folding chair' },
      { from: 19, to: 7, room: 'the_airfield', doing: 'hangar, tinkering' },
    ],
    talk: [
      '"Retirement lasted four months. Turns out the sky don’t take the hint."',
      '"Lessons start on the ground: wind sock, then weather, then wings. Skip a step and the step won’t skip you."',
      '"The night flight over the city — every ward below you, sound and light. There’s no describing it, so I’ll be describing it the whole way."',
    ],
    ambient: ['Cass squints at the wind sock and adjusts the day’s plan by a notch.', 'Cass pats the crop duster like a good horse.'],
  },
  {
    id: 'chike', name: 'Amara Chike', aka: 'Dr. Chike',
    desc: 'Mercy’s day shift in a coat that stays crisp through anything. Fast hands, slow voice — the combination that makes a bad hour survivable.',
    home: 'mercy_hospital', family: [],
    wants: ['a quiet flu season', 'the vending machine outside to admit it dispenses free soup in snow'],
    schedule: [
      { from: 7, to: 19, room: 'mercy_hospital', doing: 'on rounds' },
      { from: 19, to: 7, room: 'mercy_hospital', doing: 'off; Pruitt has it' },
    ],
    talk: [
      '"You’re Well until something happens. That’s not a diagnosis, that’s the city’s whole health plan, and honestly it holds up."',
      '"Mercy doesn’t close. Never has. The doors got tired of the argument and gave up their locks."',
      '"Night shift is Pruitt. His jokes are worse. His hands are just as good. You’re fine either way."',
    ],
    ambient: ['Dr. Chike checks a chart, then checks the person, in the right order.', 'Dr. Chike steals ten seconds of window light like medicine.'],
  },
];

const CENSUS_BY_ID = Object.fromEntries(CENSUS.map((c) => ['npc:' + c.id, c]));

/* ── WEATHER (deterministic, Missouri-flavored) ────────────────────────────
 * Pure function of the real calendar: same hour, same sky, every process.
 * Occasionally dramatic for no reason, per the design doc and per Missouri. */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}
function centralNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', hour12: false,
    minute: 'numeric', month: 'numeric', day: 'numeric', year: 'numeric',
  }).formatToParts(new Date());
  const g = (t) => parseInt(parts.find((p) => p.type === t)?.value || '0', 10);
  return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour') % 24, mi: g('minute') };
}
const WEATHER_LINES = {
  clear: 'The sky is clear and means it.',
  overcast: 'Low gray cloud, even and patient.',
  rain: 'Rain — steady, honest rain that changes every roof into an instrument.',
  storm: 'Storm. Thunder rolls the whole sky like furniture being moved upstairs.',
  fog: 'Fog off the water, thick enough to borrow. The foghorn talks in long vowels.',
  snow: 'Snow, coming down like it has nowhere better to be.',
  heat: 'Heat with weight to it. Even the shade is sweating.',
};
function weatherNow() {
  const t = centralNow();
  const slot = Math.floor(t.h / 3);
  const roll = hashStr(`${t.y}-${t.mo}-${t.d}-${slot}-rev`) % 100;
  const winter = t.mo === 12 || t.mo <= 2;
  const summer = t.mo >= 6 && t.mo <= 8;
  let kind;
  if (winter) kind = roll < 45 ? 'clear' : roll < 65 ? 'overcast' : roll < 80 ? 'snow' : roll < 92 ? 'fog' : 'rain';
  else if (summer) kind = roll < 40 ? 'clear' : roll < 60 ? 'heat' : roll < 75 ? 'overcast' : roll < 88 ? 'rain' : 'storm';
  else kind = roll < 45 ? 'clear' : roll < 65 ? 'overcast' : roll < 82 ? 'rain' : roll < 90 ? 'fog' : 'storm';
  return { kind, line: WEATHER_LINES[kind] };
}

function npcDoingNow(userId) {
  const def = CENSUS_BY_ID[userId];
  if (!def) return null;
  const { h } = centralNow();
  for (const s of def.schedule) {
    const inSlot = s.from <= s.to ? h >= s.from && h < s.to : h >= s.from || h < s.to;
    if (inSlot) return { room: s.room, doing: s.doing };
  }
  return { room: def.home, doing: 'about' };
}

function npcTalkLine(def) {
  return def.talk[Math.floor(Math.random() * def.talk.length)];
}

/* ── THE CARVE (idempotent, insert-if-absent — never clobbers her hands) ── */
async function carveReverie() {
  const meta = await MooDistrict.findOne({ districtId: 'reverie_meta' }).lean();
  if (meta && meta.props && meta.props.seedVersion >= REVERIE_SEED_VERSION) return false;
  logger.info('[reverie] carving the city (seed v' + REVERIE_SEED_VERSION + ')…');

  for (const w of WARDS) {
    await MooDistrict.updateOne(
      { districtId: w.districtId },
      { $setOnInsert: { name: w.name, desc: '', props: w.props } },
      { upsert: true },
    );
  }
  let newRooms = 0;
  for (const r of CITY_ROOMS) {
    const res = await MooRoom.updateOne(
      { roomId: r.roomId },
      { $setOnInsert: { name: r.name, district: r.district, desc: r.desc, exits: r.exits, props: { ...r.props, seedVersion: REVERIE_SEED_VERSION }, createdBy: 'reverie_seed' } },
      { upsert: true },
    );
    if (res.upsertedCount) newRooms++;
  }
  for (const i of CITY_ITEMS) {
    await MooItem.updateOne(
      { itemId: i.itemId },
      { $setOnInsert: { name: i.name, desc: i.desc, location: i.location, portable: i.portable, props: { seedVersion: REVERIE_SEED_VERSION } } },
      { upsert: true },
    );
  }
  /* Connectors into the standing gate rooms — each patched ONLY if that
   * direction is still free (the Angel may have used it since). */
  const connectors = [
    { roomId: 'founders_square', dir: 'n', dest: 'bell_court_street' },
    { roomId: 'coldpipe_alley', dir: 'w', dest: 'the_stairs' },
  ];
  for (const c of connectors) {
    const room = await MooRoom.findOne({ roomId: c.roomId }).lean();
    if (room && !(room.exits || {})[c.dir]) {
      await MooRoom.updateOne({ roomId: c.roomId }, { $set: { [`exits.${c.dir}`]: c.dest } });
    }
  }
  /* The Kettle grows what the plan gave it (tea, a warm corner) — props only,
   * never prose, and only where unset. */
  const kettle = await MooRoom.findOne({ roomId: 'the_kettle' }).lean();
  if (kettle) {
    const patch = {};
    if (!kettle.props?.food) patch['props.food'] = { menu: 'tea, coffee better than Pat’s, and a scone situation', price: 1 };
    if (kettle.props?.sleepable === undefined) patch['props.sleepable'] = true;
    if (!kettle.props?.doings) patch['props.doings'] = 'Tea and quiet judgment. Quiz night Wednesdays — the Archive team always wins and everyone is sick of it.';
    if (!kettle.props?.opinion) patch['props.opinion'] = true;
    if (Object.keys(patch).length) await MooRoom.updateOne({ roomId: 'the_kettle' }, { $set: patch });
  }
  /* The census takes its posts. */
  for (const c of CENSUS) {
    const at = npcDoingNow('npc:' + c.id) || { room: c.home };
    await MooChar.updateOne(
      { userId: 'npc:' + c.id },
      { $setOnInsert: {
          name: c.name, active: true, roomId: at.room, lastSeenSeq: 0,
          attrs: { npc: true, alive: true, desc: c.desc, aka: c.aka, home: c.home, family: c.family, wants: c.wants, coin: 20 },
        } },
      { upsert: true },
    );
  }
  /* Grandfather clause (seed v3): characters born before the comfort attrs
   * arrive Fed, Rested, and with the same pocket money newcomers get. The
   * Founder does not walk her own city broke. */
  const nowMs = Date.now();
  await MooChar.updateMany({ 'attrs.coin': { $exists: false } }, { $set: { 'attrs.coin': 20 } });
  await MooChar.updateMany({ 'attrs.lastMeal': { $exists: false } }, { $set: { 'attrs.lastMeal': nowMs } });
  await MooChar.updateMany({ 'attrs.lastSleep': { $exists: false } }, { $set: { 'attrs.lastSleep': nowMs } });
  await MooDistrict.updateOne(
    { districtId: 'reverie_meta' },
    { $set: { name: 'reverie meta', 'props.seedVersion': REVERIE_SEED_VERSION, 'props.carvedAt': new Date().toISOString() } },
    { upsert: true },
  );
  if (newRooms > 0) {
    const seq = await nextSeq();
    await MooEvent.create({ seq, roomId: 'founders_square', actorUserId: null, actorName: 'the world', kind: 'system', text: 'Overnight, the city grew. Streets run now where there was fog: the Bell, the Hook, Tanglefoot, the Patch, Millrace, Sweetwater, Fairlawn, Long Acre. Say map anywhere to hear how a ward hangs together.', at: new Date() });
  }
  logger.info(`[reverie] carve done — ${newRooms} new rooms, ${CENSUS.length} citizens on the ledger.`);
  return true;
}

/* ── THE TICK (throttled; the world breathes between commands) ───────────── */
let lastTickAt = 0;
let lastWeatherKind = null;
let lastHornDate = null;
let ambientCursor = 0;

async function activePlayerRooms() {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  const players = await MooChar.find({
    userId: { $not: /^npc:/ }, lastActiveAt: { $gte: cutoff },
  }).select('roomId').lean();
  return [...new Set(players.map((p) => p.roomId))];
}

async function tickWorld() {
  const now = Date.now();
  if (now - lastTickAt < 45 * 1000) return;
  lastTickAt = now;
  try {
    /* 1 — the census keeps its schedule. */
    const npcs = await MooChar.find({ userId: /^npc:/ }).select('userId name roomId').lean();
    for (const npc of npcs) {
      const slot = npcDoingNow(npc.userId);
      if (!slot || slot.room === npc.roomId) continue;
      const destExists = await MooRoom.findOne({ roomId: slot.room }).select('roomId').lean();
      if (!destExists) continue;
      await MooChar.updateOne({ userId: npc.userId }, { $set: { roomId: slot.room, lastActiveAt: new Date() } });
      const seqA = await nextSeq();
      await MooEvent.create({ seq: seqA, roomId: npc.roomId, actorUserId: npc.userId, actorName: npc.name, kind: 'leave', text: `${npc.name} heads out.`, at: new Date() });
      const seqB = await nextSeq();
      await MooEvent.create({ seq: seqB, roomId: slot.room, actorUserId: npc.userId, actorName: npc.name, kind: 'enter', text: `${npc.name} arrives — ${slot.doing}.`, at: new Date() });
    }
    const rooms = await activePlayerRooms();
    if (!rooms.length) return;
    /* 2 — weather turns, where sky can be felt. */
    const w = weatherNow();
    if (lastWeatherKind === null) lastWeatherKind = w.kind;
    else if (w.kind !== lastWeatherKind) {
      lastWeatherKind = w.kind;
      const outdoor = await MooRoom.find({ roomId: { $in: rooms }, 'props.outdoor': true }).select('roomId').lean();
      for (const r of outdoor) {
        const seq = await nextSeq();
        await MooEvent.create({ seq, roomId: r.roomId, actorUserId: null, actorName: 'the sky', kind: 'system', text: `The weather turns. ${w.line}`, at: new Date() });
      }
    }
    /* 3 — the night freight, once a night, heard everywhere someone is. */
    const t = centralNow();
    const today = `${t.y}-${t.mo}-${t.d}`;
    if (t.h === 23 && t.mi >= 35 && lastHornDate !== today) {
      lastHornDate = today;
      for (const roomId of rooms) {
        const seq = await nextSeq();
        await MooEvent.create({ seq, roomId, actorUserId: null, actorName: 'the night freight', kind: 'system', text: 'Far off, the night freight sounds its horn — long vowels rolling over the roofs. Every ward hears it at a different distance. Old-timers claim they can tell the load. They cannot. They will not stop.', at: new Date() });
      }
    }
    /* 4 — one ambient breath of the census, sometimes. */
    if (Math.random() < 0.35) {
      const hereNpcs = await MooChar.find({ userId: /^npc:/, roomId: { $in: rooms } }).select('userId name roomId').lean();
      if (hereNpcs.length) {
        const npc = hereNpcs[ambientCursor++ % hereNpcs.length];
        const def = CENSUS_BY_ID[npc.userId];
        if (def && def.ambient && def.ambient.length) {
          const line = def.ambient[Math.floor(Math.random() * def.ambient.length)];
          const seq = await nextSeq();
          await MooEvent.create({ seq, roomId: npc.roomId, actorUserId: npc.userId, actorName: npc.name, kind: 'emote', text: line, at: new Date() });
        }
      }
    }
  } catch (e) {
    logger.warn('[reverie] tick stumbled (non-fatal): ' + (e && e.message));
  }
}

module.exports = { carveReverie, tickWorld, weatherNow, npcDoingNow, npcTalkLine, CENSUS, CENSUS_BY_ID, WARDS, REVERIE_SEED_VERSION };
