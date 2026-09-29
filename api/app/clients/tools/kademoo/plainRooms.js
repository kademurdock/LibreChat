/* plainRooms.js — plain words for the older rooms (Sep 29 2026, seed v12).
 *
 * Kade, Sep 28: write for dyslexic readers and other reading needs as well as
 * blind players (REVERIE_PLAIN_LANGUAGE.md). The seed in reverie.js carries
 * the new text for a fresh city; this list moves a LIVE room to it only while
 * that room still holds the exact old seed text, so a room the Founder has
 * edited is never touched. Written by a writer and checked by a second
 * reader against the rules and the original, one ward at a time.
 */
'use strict';

const PLAIN_ROOM_TEXT = [
  {
    "roomId": "bell_court_street",
    "oldDesc": "The Archive bell rings the hour somewhere overhead, late as always, and pigeons argue about it. Brick underfoot, bookshop dust and tea on the air. The Archive stands north, Mercy glows east at the street’s end, the bank and the Mark Exchange face off midblock, and the courthouse keeps its wide steps swept. The tram stops here.",
    "desc": "The Archive bell rings the hour somewhere overhead. The bell is late, as always. The pigeons argue about it. The street is brick underfoot. The air smells of bookshop dust and tea. The Archive stands to the north. Mercy, the hospital, glows to the east at the end of the street. The bank and the Mark Exchange face each other in the middle of the block, like rivals. The bank is up. The Mark Exchange is down. The courthouse keeps its wide steps swept. The tram stops here.",
    "oldDoings": "Ride the tram. Step into the Archive, the bank, the Mark Exchange, Mercy, or the courthouse. Listen for the bell being wrong.",
    "doings": "Ride the tram. Visit the Archive or Mercy. Step into the bank, the Mark Exchange, or the courthouse. Listen for the bell being wrong."
  },
  {
    "roomId": "the_archive",
    "oldDesc": "Paper, wax, and quiet — the loud kind of quiet a big reading room makes. Long tables, a row of terminals, shelves that go back further than the light does. The bell tower stairs are roped off with a sign that says SOON. The records office keeps a window at the back, and a narrow stair climbs to the Founder’s Office.",
    "desc": "Paper, wax, and quiet. This is the loud kind of quiet that a big reading room makes. There are long tables and a row of computer terminals. The shelves go back further than the light does. The bell tower stairs are roped off. A sign says SOON. The Records Office keeps a window at the back of the room. The Records Office is to the north. A narrow stair climbs up to the Founder’s Office.",
    "oldDoings": "Read at the long tables. Search the chronicle at a terminal. Ask Ines almost anything. The records office window is north; the Founder’s Office is up.",
    "doings": "Read at the long tables. Search the chronicle at a terminal. The chronicle is the city’s record of what happens. Ask Ines almost anything. The Records Office window is to the north. The Founder’s Office is up."
  },
  {
    "roomId": "records_office",
    "oldDesc": "A window, a counter worn smooth by elbows, and one clerk’s eyebrow that does most of the talking. Ink and old paper. Names get made official here — first and last, like everyone on the ledger — and the fee jar takes what it takes. The old names never leave the book; that is the point of the book.",
    "desc": "A window, and a counter worn smooth by elbows. There is one clerk. The clerk’s eyebrow does most of the talking. The office smells of ink and old paper. Names get made official here. You get a first name and a last name, like everyone on the ledger. The ledger is the city’s book of names. The fee jar takes what it takes. The old names never leave the book. That is the point of the book.",
    "oldDoings": "Register a name, change a name (the old one stays on your record forever), or ask what the ledger remembers.",
    "doings": "Register a name. Change a name. Your old name stays on your record forever. Ask what the ledger remembers."
  },
  {
    "roomId": "founders_office",
    "oldDesc": "A small room that smells faintly of lemon polish and patience. Six chairs, a low table of magazines from years that have not happened, and a door whose sign has said BACK IN FIVE MINUTES since the city opened. Set into the door is a brass slot. When it takes a petition, it makes a sound like a throat clearing politely.",
    "desc": "A small room that smells faintly of lemon polish and patience. There are six chairs. A low table holds magazines from years that have not happened. A door has a sign that says BACK IN FIVE MINUTES. The sign has said that since the city opened. A brass slot is set into the door. The slot takes petitions, which are written requests to the Founder. Each time a petition goes in, the slot makes a sound like a throat clearing politely.",
    "oldDoings": "Wait, if you like waiting. Read a magazine from a year that has not happened. Slip a petition through the slot — petition <your words> works here best of anywhere, though she hears you from anywhere.",
    "doings": "Wait, if you like waiting. Read a magazine from a year that has not happened. Slip a petition through the slot. A petition is a written request to the Founder. Use petition <your words>. Petitions work best from this room. Still, the Founder hears you from anywhere."
  },
  {
    "roomId": "mercy_hospital",
    "oldDesc": "Doors that open before you touch them, and behind them the small beeps of machines minding their own business. Clean linen and coffee gone stale on a warmer. Mercy does not close. It never has. The waiting chairs hold whoever the night brought in, and the nurses call everyone hon regardless of paperwork.",
    "desc": "The doors open before you touch them. Behind the doors, machines make small beeps and mind their own business. The air smells of clean linen and of coffee gone stale on a warmer. Mercy does not close. The hospital never has. The waiting chairs hold whoever the night brought in. The nurses call everyone hon, short for honey, no matter what the paperwork says.",
    "oldDoings": "Get patched up. Sit with somebody. Sleep in a waiting chair — nobody minds here.",
    "doings": "Get patched up if you are hurt. Sit with somebody. Sleep in a waiting chair. Nobody minds here."
  },
  {
    "roomId": "the_bank",
    "oldDesc": "Marble that makes every footstep sound like an announcement. Pens on chains, a clock that is — unlike the bell — exactly right, and Constance behind the last window with the ledgers squared. The vault door is mostly for show. Mostly.",
    "desc": "The marble here makes every footstep sound like an announcement. Pens hang on chains. The bank clock is exactly right, unlike the Archive bell. Constance is behind the last window. Her ledgers, the bank’s account books, are squared up neatly. The vault door is mostly for show. Mostly.",
    "oldDoings": "Check your coin. Talk terms with Constance. Admire a correct clock in a ward famous for a wrong bell.",
    "doings": "Check your coin. Talk terms with Constance. That means working out a deal. Admire a clock that is right. Bellward is famous for a bell that is wrong."
  },
  {
    "roomId": "mark_exchange",
    "oldDesc": "A shopfront with a counter, a wall of small wonders people paid real support for, and in the middle of the floor: the drum. Brass, waist-high, turned once a week with a crank that needs oil and never gets it — the squeak is tradition now. Wishes go in written small. A few come true every week, and the town crier lane of the Feed says whose.",
    "desc": "A shopfront with a counter. One wall holds small wonders that people paid real support for. The drum sits in the middle of the floor. The drum is brass and waist-high. Once a week, someone turns the drum with a crank. The crank needs oil and never gets it. The squeak is tradition now. Wishes go into the drum, written small. A few wishes come true every week. The town crier lane of the Feed calls out whose wishes came true.",
    "oldDoings": "Make your one open wish for a thing you cannot afford: wish <what you want, in your own words>. Ask Oleander how the Drawing works. Read the Book of Patrons.",
    "doings": "Make a wish for a thing you cannot afford. You get one open wish at a time. Use wish <what you want, in your own words>. Ask Oleander how the Drawing works. The Drawing is the weekly turn of the drum. Read the Book of Patrons."
  },
  {
    "roomId": "the_courthouse",
    "oldDesc": "Wide steps, tall doors, and inside, wood that creaks with opinions about your posture. Days, it runs the ordinary docket. Late nights it becomes the night court, and Honorable Pham sentences with flair — forty hours reshelving at the Archive, poetry section, that class of thing. The public benches fill for the good ones.",
    "desc": "The courthouse has wide steps and tall doors. Inside, the wood creaks with opinions about your posture. In the daytime, the court works through its ordinary docket, the list of cases. Late at night, the courthouse becomes the night court. Honorable Pham hands out sentences with flair. A sentence might be forty hours putting books back on the shelves at the Archive, in the poetry section. That is the kind of thing she does. The public benches fill up for the good ones.",
    "oldDoings": "Watch the docket from the public benches. Court days ring the bell — the wrong bell, at the wrong time, which is how you know it counts.",
    "doings": "Watch the cases on the docket from the public benches. The bell rings on court days. It is the wrong bell, at the wrong time. That is how you know the court day counts."
  },
  {
    "roomId": "bureau_small_complaints",
    "oldDesc": "One desk, one drawer that will not quite shut for the paper in it, one man — Wendell — who takes every complaint in the city with total seriousness. Wind chimes, tram smells, autumn arriving late. Most of it goes in the drawer. Once in a while something gets fixed, and nobody has ever worked out the pattern.",
    "desc": "One desk. One drawer, so full of paper that it will not quite shut. One man, Wendell, who takes every complaint in the city with total seriousness. People complain about wind chimes, tram smells, and autumn arriving late. Most complaints go in the drawer. Once in a while, something gets fixed. Nobody has ever worked out the pattern.",
    "oldDoings": "File a complaint about anything. Anything. Wendell will write it down like it matters, because to him it does.",
    "doings": "File a complaint about anything. Anything. Wendell will write it down like it matters, because to him it does."
  },
  {
    "roomId": "childrens_office",
    "oldDesc": "Warm light, low chairs, a desk with a drawer of butterscotch that is somehow never empty. Crayon drawings taped at kid height. Miss Ottoline Reed runs this room unfailingly calm, and the whole ward is a little more careful because she does.",
    "desc": "Warm light and low chairs. A desk has a drawer of butterscotch candy, and somehow the drawer is never empty. Crayon drawings are taped up at kid height. Miss Ottoline Reed runs this room. She stays calm without fail. The whole ward is a little more careful because of her.",
    "oldDoings": "Talk to Miss Reed. Anyone can tell her anything about any kid in the city, and she listens all the way to the end.",
    "doings": "Talk to Miss Reed. Anyone can tell her anything about any kid in the city. She listens all the way to the end."
  },
  {
    "roomId": "hook_front_street",
    "oldDesc": "Gulls first, then chain, then the low diesel of something big idling out of sight. Front Street faces the water like it is keeping an eye on it. Salt and fish and rope. The docks rattle north, Pat’s diner steams at the water end, the fish market crowds the morning side, and the Stairs drop south toward the Patch. The tram turns around here like it is glad to.",
    "desc": "You hear gulls first. Then chain. Then the low diesel hum of something big, idling out of sight. Front Street faces the water, keeping an eye on it. The air smells of salt and fish and rope. The Docks rattle to the north. Pat’s diner steams to the west, at the water end of the street. The Fish Market is to the northwest, crowded every morning. The Stairs are to the south. They drop down toward the Patch. The tram turns around here like it is glad to.",
    "oldDoings": "Work the docks. Eat at Pat’s. Catch the ferry. Take the Stairs down to the Patch. Watch the water do what water does.",
    "doings": "Work the docks. Eat at Pat’s. Catch the ferry. Take the Stairs down to the Patch. Watch the water do what water does."
  },
  {
    "roomId": "the_docks",
    "oldDesc": "Crane cable sings when the wind leans on it. The planks are wet even when nothing else is. Crates stacked in walls, chalk marks nobody explains, and the freight line ending at the water the way it has since before the name. Dockhands move like they know exactly how heavy everything is, because they do.",
    "desc": "Crane cable sings when the wind leans on it. The planks are wet even when nothing else is. Crates are stacked into walls. They carry chalk marks that nobody explains. The freight train line ends here at the water. It has ended here since before this place had its name. Dockhands move like they know exactly how heavy everything is, because they do.",
    "oldDoings": "Work a dock shift — honest money, heavy verbs. Ask Merle what came in last night. Do not ask about certain crates.",
    "doings": "Work a dock shift. The money is honest and the verbs are heavy. Ask Merle what came in last night. Do not ask about certain crates."
  },
  {
    "roomId": "union_hall",
    "oldDesc": "Cigarette smoke and strong opinions, both secondhand. The hall’s doors stand open for meetings and stay shut for everything else, so the real business happens out here on the steps, at volume. A most-of-a-banner over the door reads LOCAL 1 — the number is a joke and a boast at the same time.",
    "desc": "Cigarette smoke and strong opinions, both secondhand. The Union Hall doors open for meetings. They stay shut for everything else. So the real business happens out here on the steps, at full volume. Most of a banner still hangs over the door. It reads LOCAL 1. A local is a branch of the union. The number is a joke and a boast at the same time.",
    "oldDoings": "Sit on the steps and hear what the harbor thinks of the chronicle. Dues get argued here. Strikes get born here.",
    "doings": "Sit on the steps. Hear what the harbor thinks of the chronicle, the city’s news. Union dues get argued here. Strikes get born here."
  },
  {
    "roomId": "pats_diner",
    "oldDesc": "Bacon, burnt coffee, and the flat-top’s steady hiss. A counter with stools worn to fit, booths with sugar shakers that stick, and Pat behind the grill at any hour you have ever checked. The coffee is bad and nobody minds. The pie rotates. The 3 a.m. crowd and the 6 a.m. crowd pretend not to know each other.",
    "desc": "Bacon, burnt coffee, and the steady hiss of the flat-top grill. The counter stools are worn to fit. The booths have sugar shakers that stick. Pat is behind the grill at any hour you have ever checked. The coffee is bad and nobody minds. The pie of the day rotates. The 3 a.m. crowd and the 6 a.m. crowd pretend not to know each other.",
    "oldDoings": "Order food — eat here does it. Hold a stool. Hear the harbor’s news secondhand while Pat scrapes the flat-top.",
    "doings": "Order food. Here, the command “eat” does it. Hold a stool. Hear the harbor’s news secondhand while Pat scrapes the flat-top grill."
  },
  {
    "roomId": "fish_market",
    "oldDesc": "Ice being shoveled, scales being argued with, and the smell that tells you everything is fresh because nothing has had time not to be. Stalls open before light and quit by noon. Gulls run the place from above and know it.",
    "desc": "Ice being shoveled. Somebody arguing with the scales. The smell tells you everything is fresh, because nothing has had time not to be. The stalls open before first light and close by noon. Gulls run the Fish Market from above, and they know it.",
    "oldDoings": "Buy the morning catch. Eat standing up. Learn which gull is the boss gull. Mornings only, really.",
    "doings": "Buy the morning catch. Eat standing up. Learn which gull is the boss gull. Mornings only, really."
  },
  {
    "roomId": "the_stairs",
    "oldDesc": "A street that is, in fact, stairs. One hundred and some steps of worn stone between the Hook above and the Patch below, with a landing halfway where everybody stops and pretends they were going to stop anyway. Everybody hates the Stairs. Everybody uses the Stairs. Coldpipe Alley leaks in from the east at the landing.",
    "desc": "A street that is, in fact, stairs. One hundred and some steps of worn stone. Up leads to the Hook. Down leads to the Patch. Halfway is a landing, a flat spot to rest. Everybody stops on the landing and pretends they were going to stop anyway. Everybody hates the Stairs. Everybody uses the Stairs. Coldpipe Alley leaks in from the east, at the landing.",
    "oldDoings": "Climb, descend, or stand on the landing catching your breath with the rest of the city.",
    "doings": "Climb up or go down. Or stand on the landing and catch your breath with the rest of the city."
  },
  {
    "roomId": "ferry_dock_hook",
    "oldDesc": "Rope creak and water slap. A pole board lists the crossings in chalk, corrected hourly by weather and mood. The ferry to Sweetwater is slow on purpose — Captain Marsh calls the speed conversational. Bikes lean where their owners trusted them to stay.",
    "desc": "Rope creak and water slap. A board on a pole lists the ferry crossings in chalk. Weather and mood correct the times every hour. The ferry to Sweetwater is slow on purpose. Captain Marsh calls the speed conversational. Bikes lean where their owners trusted them to stay.",
    "oldDoings": "Ride the ferry to Sweetwater: ferry does it. Slow and social — that is the point.",
    "doings": "Ride the ferry to Sweetwater. The command “ferry” does it. The ride is slow and social. That is the point."
  },
  {
    "roomId": "the_shack",
    "oldDesc": "CUTLER & SON MARINE SUPPLY, says the sign, and the son has not been through that door in nine years. Cane poles in a barrel by the till. Bait in a cooler that hums. A counter worn pale where forty years of elbows have leaned on it while somebody decided whether they could afford the good line.",
    "desc": "The sign says CUTLER & SON MARINE SUPPLY. The son has not been through that door in nine years. Cane fishing poles stand in a barrel by the cash register. Bait sits in a cooler that hums. The counter is worn pale. Forty years of elbows have leaned on it while somebody decided if they could afford the good fishing line.",
    "oldDoings": "Buy a pole ($6) or bait (5 casts, $2). Sell what you caught. Marva will tell you where they are biting if she likes you.",
    "doings": "Buy a pole for $6. Buy bait for $2. The bait lasts 5 casts. Sell what you caught. If Marva likes you, she will tell you where the fish are biting."
  },
  {
    "roomId": "pier_seven",
    "oldDesc": "The working pier the working boats stopped using. Seven planks in from the end, somebody has worn a pale patch standing in the same spot for years. Harbor water slaps the pilings in no rhythm you can hold onto.",
    "desc": "The working pier that the working boats stopped using. Seven planks in from the end, the wood has a pale patch. Somebody wore it pale by standing in the same spot for years. Posts called pilings hold up the pier. Harbor water slaps the pilings in no rhythm you can hold onto.",
    "oldDoings": "Fish the harbor. Watch the ferry go. Stand in the pale spot.",
    "doings": "Fish the harbor. Watch the ferry go. Stand in the pale spot."
  },
  {
    "roomId": "the_breakwater",
    "oldDesc": "A quarter mile of stacked stone holding the harbor shut against the deep. Past the last block the water changes color and stops explaining itself. People fish here for things that are not in the harbor.",
    "desc": "A quarter mile of stacked stone holds the harbor shut against the deep water. Past the last stone block, the water changes color and stops explaining itself. People fish here for things that are not in the harbor.",
    "oldDoings": "Deep water. Take a real pole or take a real disappointment.",
    "doings": "Deep water. Take a real pole or take a real disappointment."
  },
  {
    "roomId": "the_ferry_pilings",
    "oldDesc": "Under the ferry dock, where the river shoulders into the harbor and neither wins. Barnacled uprights, green light off the water on the underside of the planks, and the ferry landing overhead like weather.",
    "desc": "You are under the Ferry Dock. Here the river shoulders into the harbor, and neither one wins. Barnacles cover the pilings, the tall posts that hold up the dock. Green light bounces off the water onto the underside of the planks. Overhead, the ferry lands like weather.",
    "oldDoings": "River fishing, out of the wind, under everybody's feet.",
    "doings": "River fishing, out of the wind, under everybody’s feet."
  },
  {
    "roomId": "tanglefoot_line_street",
    "oldDesc": "Bass through brick before you see a single door. Line Street kept the streetcar rails in the cobbles and the streetcar is long gone — bikes hit them wrong and everybody hears it. Smoke, fryer oil, somebody tuning a guitar somewhere upstairs. Dez’s bar leaks music north, the Band broadcasts from over Hock’s pawn, the Game Parlor’s door never quite shuts, and the taco window feeds the line at the alley end. A sign buzzes pink. The tram stops, reluctantly.",
    "desc": "You hear bass through brick before you see a single door. Line Street kept the streetcar rails in its cobblestones. The streetcar is long gone. Bikes hit the rails wrong, and everybody hears it. The air smells of smoke and fryer oil. Somebody upstairs is tuning a guitar. Dez’s bar is to the north. Music leaks out of Dez’s. Hock’s Pawn is to the east. The Band, the city’s radio station, broadcasts from above Hock’s. The Game Parlor is to the south. The Parlor’s door never quite shuts. The taco window is to the southeast, at the alley end. The window feeds the people in line. Court Street is to the northwest. A sign buzzes pink. The tram stops here, as if it would rather not.",
    "oldDoings": "Follow the music to Dez’s. Pawn something at Hock’s. Play cards at the Parlor. Eat at the window. Tanglefoot starts when the light quits.",
    "doings": "Follow the music to Dez’s. Pawn something at Hock’s. Play cards at the Game Parlor. Eat at the taco window. Tanglefoot starts when the daylight quits."
  },
  {
    "roomId": "dezs_bar",
    "oldDesc": "The door opens and the room arrives all at once: warm noise, spilled beer gone sticky, a stage the size of a rug and a crowd that treats it like an arena. Dez runs the bar unbothered by anything, including fires, heartbreak, and requests. The good stool is the third one. Everyone knows. Nobody says.",
    "desc": "The door opens and the whole room hits you at once. Warm noise. Spilled beer gone sticky. The stage is the size of a rug. The crowd treats the stage like an arena. Dez runs the bar. Nothing bothers Dez. Not fires, not heartbreak, not requests. The good stool is the third one. Everyone knows. Nobody says. Line Street is to the south.",
    "oldDoings": "Hold the third stool if you dare. Hear live music most nights. Work a bar shift if Dez nods at you.",
    "doings": "Hold the third stool if you dare. Hear live music most nights. Work a bar shift if Dez nods at you."
  },
  {
    "roomId": "the_band_station",
    "oldDesc": "One room, one desk, one microphone with a sock on it, and the whole city on the other side. The Band is Reverie’s only station, and it sounds like it: music blocks, the weather, a call-in hour where anybody’s voice can end up on everybody’s radio. The ON AIR bulb is honest. The board op’s coffee is not.",
    "desc": "One room. One desk. One microphone with a sock on it. The whole city is on the other side of that microphone. The Band is Reverie’s only radio station, and it sounds like it. It plays blocks of music. It gives the weather. It has a call-in hour, when anybody’s voice can end up on everybody’s radio. The stairs go down to Hock’s Pawn. The board op is the person who runs the sound controls. The ON AIR bulb is honest. The board op’s coffee is not.",
    "oldDoings": "Watch a broadcast go out. The call-in hour takes callers from any brick in the city. The Founder can commandeer this desk, and everyone here knows it.",
    "doings": "Watch a broadcast go out. The call-in hour takes callers from any brick in the city. The Founder can take over this desk. Everyone here knows it."
  },
  {
    "roomId": "pawn_hocks",
    "oldDesc": "Dust, oiled metal, and forty years of other people’s decisions on shelves. Every item in here kept its history — buy the guitar and you get its owners’ story with it, whether you asked or not. Hock knows the provenance of everything and the price of most things. The stairs behind the counter go up to the Band. The back door is a different business.",
    "desc": "Dust, oiled metal, and forty years of other people’s decisions, all on shelves. Every item in Hock’s kept its history. Buy the guitar, and you get its owners’ story with it, whether you asked or not. Hock knows where everything came from. He knows the price of most things. The stairs behind the counter go up to the Band, the city’s radio station. The back door is a different business. Line Street is to the west.",
    "oldDoings": "Browse things with pasts. Ask Hock what something has seen. Sell, if you can stand his first offer.",
    "doings": "Browse things with pasts. Ask Hock what something has seen. Sell, if you can stand his first offer."
  },
  {
    "roomId": "game_parlor",
    "oldDesc": "Card shuffle and table talk in a long low room that smells like felt and old luck. Twenty-one tables, each mid-something: Hearts, Spades, dice, dominoes. Walk in, sit down, play with whoever is there. The house keeps no book — the games referee themselves, which everyone finds either comforting or suspicious depending on their week.",
    "desc": "Card shuffle and table talk. The Game Parlor is a long, low room that smells like felt and old luck. There are twenty-one tables. Each table is in the middle of something: Hearts, Spades, dice, dominoes. Walk in, sit down, and play with whoever is at the table. The house keeps no book. No one who works here judges the games. The games referee themselves. Everyone finds that either comforting or suspicious. It depends on their week. Line Street is to the north.",
    "oldDoings": "Sit at a table and play — the Parlor’s twenty-one games run day and night at kademurdock.com/parlor, same tables, same city.",
    "doings": "Sit at a table and play. The Parlor’s twenty-one games run day and night at kademurdock.com/parlor. Same tables, same city."
  },
  {
    "roomId": "taco_window",
    "oldDesc": "A sliding window in an alley wall, a griddle you hear before you smell and smell before you see, and a line that self-organizes at 2 a.m. like it rehearsed. The menu is a card taped inside the glass. The card is a lie; you order by pointing at what the person ahead of you got.",
    "desc": "A sliding window is set into an alley wall. Behind the window is a griddle. You hear the griddle before you smell it. You smell it before you see it. At 2 a.m. the line puts itself in order, like it rehearsed. The menu is a card taped inside the glass. The card is a lie. You order by pointing at what the person ahead of you got. Line Street is to the northwest.",
    "oldDoings": "Eat in the alley with the night crowd. The line is the social club.",
    "doings": "Eat in the alley with the night crowd. The line is the social club."
  }
];

module.exports = { PLAIN_ROOM_TEXT };
