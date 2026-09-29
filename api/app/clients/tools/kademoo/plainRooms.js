/* plainRooms.js — plain words for the older rooms (Sep 29 2026, seed v12).
 *
 * Kade, Sep 28: write for dyslexic readers and other reading needs as well as
 * blind players (REVERIE_PLAIN_LANGUAGE.md). The seed in reverie.js carries
 * the new text for a fresh city; this list moves a LIVE room to it only while
 * that room still holds the exact old seed text, so a room the Founder has
 * edited is never touched. Written by a writer and checked by a second
 * reader against the rules and the original, one ward at a time
 * (Sep 29: Bellward, the Hook, Tanglefoot, the Patch, the Millrace,
 * Sweetwater, Fairlawn, Long Acre and Gravewalk).
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
  },
  {
    "roomId": "patch_gully_road",
    "oldDesc": "Somebody’s frying onions and it is not even noon. Row houses lean shoulder to shoulder, laundry lines cross overhead like bunting, and every stoop holds either a person, a plant, or a story waiting for one. The Stairs climb north to the Hook. Levi’s pole spins at the corner, Ruth-Ann’s stoop is the green one, Doc’s clinic keeps its light on, and the corner store rings its little bell all day. The tram stops where the paint says it does.",
    "desc": "Somebody’s frying onions, and it is not even noon. Row houses lean shoulder to shoulder. Laundry lines cross overhead like strings of party flags. Every front stoop holds a person, a plant, or a story waiting for someone. The Stairs climb up to the Hook. Levi’s Chairs is to the west. Levi’s barber pole spins at the corner. Ruth-Ann’s stoop is to the north. Her stoop is the green one. Doc’s clinic is to the southeast. The clinic keeps its light on. The corner store is to the south. Its little bell rings all day. The Payphone is to the southwest. The Millrace is to the east. The tram stops where the paint on the street says it does.",
    "oldDoings": "Sit for a cut at Levi’s. Check Ruth-Ann’s tomatoes. Hit the corner store. See Doc about anything. The Patch talks — mostly to you.",
    "doings": "Sit for a haircut at Levi’s. Check on Ruth-Ann’s tomatoes. Stop at the corner store. See Doc about anything. The Patch talks. Mostly it talks to you."
  },
  {
    "roomId": "levis_chairs",
    "oldDesc": "Clippers, laughter, and the chronicle read aloud with corrections. Three chairs, one Levi, infinite opinions. The mirror wall doubles the room and the volume. Sitting for a cut means hearing the city’s real news filtered through the loudest men alive, and coming out sharper two ways.",
    "desc": "Clippers and laughter fill the room. Levi reads the chronicle, the city newspaper, out loud. He corrects it as he goes. Three chairs, one Levi, endless opinions. The mirror wall makes the room look twice as big and sound twice as loud. Sit for a haircut and you hear the city’s real news. The loudest men alive are telling it. You leave sharper in two ways: in the hair and in the head. Gully Road is to the east.",
    "oldDoings": "Sit for a cut. Get pulled into the argument whether you sit or not. The wall outside is curated by consensus.",
    "doings": "Sit for a haircut. Get pulled into the argument, whether you sit or not. Everybody has to agree on what goes up on the wall outside."
  },
  {
    "roomId": "ruth_anns_stoop",
    "oldDesc": "A green-painted stoop, tomato plants in buckets doing better than anything in Fairlawn, and Ruth-Ann herself most hours, shelling something into a bowl. She has opinions about your posture, your coat, and your love life, and she will feed you without asking because asking wastes soup time.",
    "desc": "Ruth-Ann’s stoop is painted green. A stoop is a set of front steps. Tomato plants grow here in buckets. They do better than anything in Fairlawn, the rich ward. Ruth-Ann herself sits here most hours, shelling something into a bowl. She has opinions about your posture, your coat, and your love life. She will feed you without asking. Asking wastes soup time. Gully Road is to the south.",
    "oldDoings": "Eat — free, argued over, unforgettable. Water her tomatoes if she is not out. She will know either way.",
    "doings": "Eat here. The food is free, argued over, and unforgettable. If Ruth-Ann is not out on the stoop, water her tomatoes. She will know either way."
  },
  {
    "roomId": "corner_store",
    "oldDesc": "A bell over the door that has announced three generations. Shelf-crowded, everything findable only by asking. The counter sells bricks — the pocket kind, calls and the Feed included — takes bottle deposits in nickels from kids running their first economy, and posts the numbers nobody officially plays.",
    "desc": "The bell over the door has announced customers for three generations. The shelves are crowded. The only way to find anything is to ask. The counter sells bricks. A brick is a pocket phone, with calls and the Feed included. Kids bring empty bottles to the counter and get paid in nickels. They are running their first economy. The store also posts the numbers for a street lottery. Officially, nobody plays it. Gully Road is to the north.",
    "oldDoings": "Buy a brick — buy brick, if you have the coin. Redeem bottles. Read the notices taped to the glass.",
    "doings": "Buy a brick if you have the money. To buy one, type buy brick. Trade in your bottles for nickels. Read the notices taped to the glass."
  },
  {
    "roomId": "the_clinic",
    "oldDesc": "A storefront with a hand-lettered sign and a waiting row of folding chairs. Rubbing alcohol and coffee. Doc treats everything, asks nothing, and keeps a jar of lollipops that is somehow never empty. Nobody knows where the funding comes from. The jar knows. The jar says nothing. Tuesdays, the folding chairs make a circle.",
    "desc": "The Clinic is a storefront with a hand-lettered sign. A row of folding chairs makes the waiting area. The room smells of rubbing alcohol and coffee. Doc treats everything and asks nothing. Doc keeps a jar of lollipops that is somehow never empty. Nobody knows where the money for the Clinic comes from. The jar knows. The jar says nothing. On Tuesdays, the folding chairs make a circle. Gully Road is to the northwest.",
    "oldDoings": "See Doc about anything, no questions. Tuesdays the Returned meet here — coffee, folding chairs, the most human room in the city.",
    "doings": "See Doc about anything. Doc asks no questions. On Tuesdays, a group called the Returned meets here. They sit in folding chairs and drink coffee. This is the most human room in the city."
  },
  {
    "roomId": "patch_payphone",
    "oldDesc": "A payphone, upright and inexplicable, decades past its species going extinct. Kids dare each other to stand near it. It has a dial tone. Nobody pays for a dial tone. Some nights — never the same nights — it rings, and the Patch pretends very hard not to count who answers.",
    "desc": "A payphone stands here, upright. Nobody can explain why. Payphones as a species went extinct decades ago. Kids dare each other to stand near the payphone. The payphone has a dial tone. Nobody pays for a dial tone. Some nights the payphone rings. Never the same nights. The Patch pretends very hard not to count who answers. Gully Road is to the northeast.",
    "oldDoings": "Stand near it. Wait. Answer it, if it rings and you are the kind of person who answers.",
    "doings": "Stand near the payphone. Wait. If the payphone rings, answer it. That is, if you are the kind of person who answers."
  },
  {
    "roomId": "millrace_channel",
    "oldDesc": "Water still runs the old channel out of habit, thin and quick over green stone. Grinders somewhere, a radio somewhere else, and the particular clang of somebody hitting a thing that deserved it. The mills the race fed are garages and shops now. Kids fly drones down the channel slot on race nights and the garden club has filed about it, twice.",
    "desc": "Water still runs down the old channel out of habit. The water is thin and quick over green stone. Grinders whine somewhere. A radio plays somewhere else. There is also the particular clang of somebody hitting a thing that deserved it. This old channel is the Millrace. The Millrace once carried water to the mills. Those mills are garages and shops now. On race nights, kids fly drones down the narrow slot of the channel. The garden club has filed a complaint about the drones. Twice.",
    "oldDoings": "Watch a drone run the channel. Follow the clang to the garages. Saturdays the junk market swallows the street.",
    "doings": "Watch a drone fly down the channel. Follow the clang east to the Garages. On Saturdays, the junk market swallows the street."
  },
  {
    "roomId": "salvage_yard",
    "oldDesc": "Rust in ranks. The yard buys by weight and by interest, and the scale groans either way. Most hauls are junk. Some junk is interesting junk, and interesting junk starts threads. The freight line runs along the back fence, close enough to rattle the loose stuff when the night train passes.",
    "desc": "Rust in ranks: row after row of rusted metal. The yard buys scrap by weight and by how interesting the scrap is. The scale groans either way. Most hauls are junk. Some junk is interesting junk. Interesting junk starts threads. A thread is a story worth following. The freight train line runs close along the back fence. When the night train passes, it rattles the loose stuff.",
    "oldDoings": "Work a salvage shift. Poke the piles for interesting junk. Hear the fence rattle when the freight goes by.",
    "doings": "Work a salvage shift. Poke through the piles for interesting junk. Hear the fence rattle when the freight train goes by."
  },
  {
    "roomId": "the_garages",
    "oldDesc": "Engine oil, weld smoke, and the tick of hot metal cooling. Roll-up doors in a row, each with a different radio and a different philosophy of glue. If it is broken, somebody in here can fix it. If it is not broken, give them an hour.",
    "desc": "Engine oil, weld smoke, and the tick of hot metal cooling. Roll-up doors stand in a row. Each garage has its own radio. Each one also has its own philosophy about glue. If something is broken, somebody in here can fix it. If it is not broken, give them an hour.",
    "oldDoings": "Bring something broken. Leave with it fixed and a lecture. Burn scars optional but traditional.",
    "doings": "Bring something broken. Leave with it fixed, plus a lecture. Burn scars are optional but traditional."
  },
  {
    "roomId": "bowling_lanes",
    "oldDesc": "Pin crash and rental-shoe spray. Eight lanes, a scoreboard with one dead bulb the league refuses to fix for luck, and a trophy case whose centerpiece is famous for being stolen — the stealing is the tradition now, and the case door is left unlocked accordingly.",
    "desc": "Pins crash. The air smells of rental-shoe spray. There are eight lanes. The scoreboard has one dead bulb. The league refuses to fix the bulb, for luck. The main trophy sits in the middle of the trophy case. That trophy is famous for being stolen. Stealing that trophy is the tradition now. So the case door is left unlocked on purpose.",
    "oldDoings": "Bowl a frame. Join league night by showing up three times. Do not be the one who breaks the trophy tradition by keeping it.",
    "doings": "Bowl a frame. A frame is one turn at the pins. Join league night by showing up three times. Do not be the one who breaks the tradition by keeping the trophy."
  },
  {
    "roomId": "sweetwater_park",
    "oldDesc": "Wind through leaves, then water, then ducks announcing your arrival to no one. Grass mowed by somebody who loves it, paths that curve for no reason a straight line would understand. The garden plots run east, the bandshell holds the lawn’s far side, the fountain glitters mid-park, and the pier noses into the river past Treehouse Row. Morning people own this place until nine.",
    "desc": "Wind moves through the leaves. Then comes the sound of water. Then the ducks announce your arrival to no one. The grass is mowed by somebody who loves it. The paths curve for no reason a straight line would understand. The Garden Plots are to the east. The Bandshell is to the west, on the far side of the lawn. The Wishing Fountain is to the north. It glitters in the middle of the park. The Pier is to the northeast. It pokes out into the river, past Treehouse Row. Treehouse Row is to the northwest. Morning people own this park until nine.",
    "oldDoings": "Walk it slow. Feed the ducks and be judged by them. Everything green in the city starts here.",
    "doings": "Take a slow walk around the park. Feed the ducks and be judged by them. Everything green in the city starts here."
  },
  {
    "roomId": "garden_plots",
    "oldDesc": "Turned earth and tomato-leaf sharpness. Ranked little kingdoms, each marked with string and pride: peppers, sweet corn, herbs, sunflowers grown for nothing but the look of them. A shared shed leans agreeably. Somebody is always watering somebody else’s plot and leaving a note about it.",
    "desc": "The air smells of turned earth and sharp tomato leaves. The plots sit in neat rows, like little kingdoms. Each one is marked off with string and pride. There are peppers, sweet corn and herbs. There are sunflowers grown for nothing but the look of them. A shared shed leans at a friendly angle. Somebody is always watering somebody else’s plot and leaving a note about it.",
    "oldDoings": "Tend a plot when planting opens. Real seasons, real waiting — days, not minutes. The notes are the feature.",
    "doings": "Tend a plot when planting season opens. The seasons are real. So is the waiting: days, not minutes. The notes are the feature."
  },
  {
    "roomId": "the_pier",
    "oldDesc": "Old boards giving each footstep its own note. River smell, rope, a bench at the far end polished by every kind of weather and every kind of mood. The ferry ties up here when Marsh brings her over. The bench asks nothing. That is its whole job, and it is excellent at it.",
    "desc": "The old boards give each footstep its own note. The air smells of river and rope. A bench sits at the far end of the Pier. Every kind of weather and every kind of mood has polished the bench smooth. The ferry ties up at the Pier when Captain Marsh brings it over. The bench asks nothing of you. That is its whole job, and it is excellent at it.",
    "oldDoings": "Sit the bench. Ride the ferry to the Hook. Lantern Night, the paper lanterns launch from here.",
    "doings": "Sit on the bench. Ride the ferry to the Hook. On Lantern Night, the paper lanterns launch from the Pier."
  },
  {
    "roomId": "the_bandshell",
    "oldDesc": "A white shell that throws sound clear across the lawn — clap once and it claps back a half-beat later. Folding chairs stacked like they are waiting for a reason, and they usually get one by Friday. The choir practices here when the weather allows, and sounds better than it should.",
    "desc": "The Bandshell is a white stage shaped like a shell. It throws sound clear across the lawn. Clap once, and the shell claps back half a beat later. Folding chairs sit stacked, as if they are waiting for a reason. They usually get one by Friday. The choir practices here when the weather allows. The singing sounds better than it should.",
    "oldDoings": "Catch a show when the bell rings one in. Try the echo. Everyone tries the echo.",
    "doings": "Catch a show when the bell rings to announce one. Try the echo. Everyone tries the echo."
  },
  {
    "roomId": "wishing_fountain",
    "oldDesc": "Water over stone, coins under water, and the specific hush people make just before they want something. Throw a credit, speak a wish. The fountain files it privately and promises nothing. Every so often one comes true with no announcement at all, and the hit rate is a myth people chart anyway.",
    "desc": "Water runs over stone. Coins lie under the water. You can hear that particular hush people make just before they want something. Throw in a credit and speak a wish. The fountain files your wish away privately and promises nothing. Every so often, a wish comes true with no announcement at all. The odds are a myth. People chart them anyway.",
    "oldDoings": "Throw a coin and speak a wish to the water — quiet, private, logged where only the world can read it.",
    "doings": "Throw a coin and speak a wish to the water. The wish stays quiet and private. It is logged where only the world can read it."
  },
  {
    "roomId": "treehouse_row",
    "oldDesc": "Ladder rungs nailed to three big oaks, rope-and-pulley lines strung between the platforms, and a message bucket squeaking its way across on the pulley — objectively worse than the Feed and infinitely cooler. Kid laws apply here, which are stricter than Fairlawn’s and fairer.",
    "desc": "Ladder rungs are nailed to three big oaks. Rope-and-pulley lines stretch between the tree platforms. A message bucket squeaks its way across on a pulley. The bucket is plainly worse than the Feed. It is also infinitely cooler. Kid laws apply on Treehouse Row. Kid laws are stricter than Fairlawn’s laws, and fairer.",
    "oldDoings": "Send something across by bucket. Climb if a kid vouches for you. The creek dam project is that way somewhere, doomed and glorious.",
    "doings": "Send something across by bucket. Climb up if a kid says you can be trusted. The creek dam project is off that way somewhere. It is doomed, and it is glorious."
  },
  {
    "roomId": "the_greenhouse",
    "oldDesc": "Glass on a cast-iron frame, half the panes original and the wrong green. Warm and wet and twenty degrees away from whatever is happening outside. Seedlings in flats down both benches, labeled in four handwritings.",
    "desc": "The Greenhouse is glass on a cast-iron frame. Half the panes are original and the wrong shade of green. It is warm and wet in here. The air is twenty degrees away from whatever is happening outside. Both benches hold seedlings in shallow trays called flats. The labels are in four different handwritings.",
    "oldDoings": "Start seedlings out of season. The flats are communal and the labels are load-bearing.",
    "doings": "Start seedlings out of season. The flats are shared by everyone. The labels are load-bearing: everything depends on them."
  },
  {
    "roomId": "the_tool_shed",
    "oldDesc": "The shed that leans agreeably at the edge of the plots. Everything inside belongs to everybody and everything has been mended at least once. There is a coffee can of bent nails that nobody will throw out.",
    "desc": "This shed leans at a friendly angle on the edge of the Garden Plots. Everything inside belongs to everybody. Everything has been mended at least once. There is a coffee can full of bent nails that nobody will throw out.",
    "oldDoings": "Borrow what you need. Bring it back or hear about it.",
    "doings": "Borrow what you need. Bring it back, or you will hear about it from somebody."
  },
  {
    "roomId": "fairlawn_ave",
    "oldDesc": "Sprinklers, and under them, nothing — Fairlawn’s whole sound signature. Lawns cut to the same inch by ordinance and enthusiasm. A camera on a pole turns to watch you at walking speed, polite about it. The salon glows east, the homeowners’ hall squats civic and beige, and the gates north smile with security guards who say lovely evening like a checkpoint question. The tram stops exactly where the sign says. Of course it does.",
    "desc": "You hear sprinklers, and under the sprinklers, nothing. That is Fairlawn’s whole sound. Every lawn is cut to the same inch, by town rule and by enthusiasm. A camera on a pole turns to watch you at walking speed. The camera is polite about it. The Salon glows to the east. The Homeowners’ Hall is to the south. The Hall is squat, beige and very official. The Gates are to the north. The Gates smile at you through their security guards. The guards wish you a lovely evening. The greeting sounds like a checkpoint question. The tram stops exactly where the sign says. Of course it does.",
    "oldDoings": "Walk the avenue and be observed. Everything here is working exactly as designed, which is the funny part.",
    "doings": "Walk the avenue and be watched. Everything on Fairlawn Avenue works exactly as designed. That is the funny part."
  },
  {
    "roomId": "the_salon",
    "oldDesc": "Lavender, peroxide, and conversation with its nails done. Chairs recline, voices do not. The polite knives come out here — reputations get trimmed a quarter inch at a time, and everyone leaves saying how lovely everyone is.",
    "desc": "The Salon smells of lavender and peroxide. Peroxide is a hair bleach. Even the conversation has had its nails done. The chairs lean back. The voices do not. The polite knives come out here. The knives are gossip. Reputations get trimmed a quarter inch at a time. Then everyone leaves saying how lovely everyone is.",
    "oldDoings": "Sit for a wash and hear Fairlawn’s version of the chronicle, edited for sharpness.",
    "doings": "Sit for a hair wash. Hear Fairlawn’s version of the chronicle, the city’s news. The news comes edited for sharpness."
  },
  {
    "roomId": "hoa_hall",
    "oldDesc": "Folding tables, name placards, a gavel that gets used recreationally. The council meets over mailbox regulations, hedge heights, and one unresolved rooster complaint that is technically outside their jurisdiction and spiritually their white whale. Minutes are kept. Grudges are kept better.",
    "desc": "The Hall has folding tables, name cards and a gavel. A gavel is a small wooden hammer. People bang the gavel for fun. The council meets here about mailbox rules and hedge heights. One rooster complaint never gets settled. Technically, the rooster is not the council’s business. In spirit, the rooster is their white whale, the one thing they chase forever. The minutes, or meeting notes, are kept. Grudges are kept better.",
    "oldDoings": "Attend a council meeting if your constitution allows. The complaint forms are pre-sorted by hedge type.",
    "doings": "Attend a council meeting, if your constitution allows. That means if you are tough enough. The complaint forms are already sorted by hedge type."
  },
  {
    "roomId": "fairlawn_gates",
    "oldDesc": "Wrought iron that has never once been closed, flanked by security in jackets that match. They know your name before you say it and say lovely evening in a tone that files a report. Beyond, the private drives curl out of sight under old trees.",
    "desc": "The Gates are made of wrought iron, which is iron shaped by hand. The Gates have never once been closed. Security guards in matching jackets stand on each side. The guards know your name before you say it. They wish you a lovely evening. Their tone says they are filing a report. Past the Gates, private driveways curl out of sight under old trees.",
    "oldDoings": "Pass through and be pleasantly logged. The drives beyond are invitation business.",
    "doings": "Pass through and be pleasantly written into the guards’ log. The driveways beyond are invitation-only business."
  },
  {
    "roomId": "ring_road",
    "oldDesc": "The city ends mid-sentence and the fields pick it up. Two lanes of good blacktop looping the whole town, wind in the crops on one side, town hum fading on the other. Driving your own hands down this road at night with the windows open is one of the world’s designed pleasures, when you have earned the license. The truck stop shines east. The rails cross at the marked grade south.",
    "desc": "The city ends mid-sentence, and the fields finish it. The Ring Road is two lanes of good blacktop that loop around the whole town. Wind moves through the crops on one side. The hum of town fades on the other side. Driving this road at night is one of the world’s designed pleasures. You drive with your own hands, windows open. First, you have to earn the license. The Truck Stop shines to the east. The Grade Crossing is to the south. That is the marked spot where the rails cross the road.",
    "oldDoings": "Walk the shoulder. Someday: drive it, hands on the wheel, windows down. The manual license is pure status and worth it.",
    "doings": "Walk the shoulder at the road’s edge. Someday, drive the road yourself, hands on the wheel, windows down. The manual license is pure status, and it is worth it."
  },
  {
    "roomId": "long_acre_fields",
    "oldDesc": "Crop rows to the horizon, insect hum, a windbreak of old trees leaning east together like they voted on it. The dirt smells like work that matters. Harvest turns this whole ward into one long shared shift, and the pie afterward is the wage that counts.",
    "desc": "Crop rows run all the way to the horizon. Insects hum. A windbreak of old trees shields the crops from the wind. The trees all lean east together, like they voted on it. The dirt smells like work that matters. At harvest, this whole ward turns into one long shared shift. The pie afterward is the wage that counts.",
    "oldDoings": "Work the fields in season. Learn what the Long Acre families know and do not write down.",
    "doings": "Work the fields in season. Learn what the Long Acre families know and do not write down."
  },
  {
    "roomId": "the_truck_stop",
    "oldDesc": "Fryer hiss and a radio on the Band, half static and staying that way. Vinyl booths, a counter that has heard everything twice, a pie case turning slow under warm light. The highway out front goes somewhere and mostly does not come back, and the coffee is better than Pat’s, which nobody in the Hook will ever hear said aloud.",
    "desc": "The fryer hisses. A radio plays the Band, the city’s radio station. The signal is half static and staying that way. The booths are vinyl. The counter has heard everything twice. A pie case turns slowly under warm light. The highway out front goes somewhere and mostly does not come back. The coffee here is better than the coffee at Pat’s diner. Nobody in the Hook will ever hear that said aloud.",
    "oldDoings": "Eat. Watch the highway. Ask a driver where the road goes and get a different answer every time.",
    "doings": "Eat. Watch the highway. Ask a driver where the road goes. You get a different answer every time."
  },
  {
    "roomId": "the_rails",
    "oldDesc": "Two rails running silver out of one horizon and into the other, crossties breathing creosote in the sun. The crossing bell hangs quiet until it is not. The night freight comes through around 11:40 with its long-voweled horn, and the whole city hears it at a different distance. The rails are the one place out here that means it: trains do not stop. Every kid in the city has been told.",
    "desc": "Two silver rails run out of one horizon and into the other. The wooden crossties under them breathe out creosote in the sun. Creosote is a dark, tar-smelling oil that keeps the wood from rotting. The crossing bell hangs quiet until it is not. The night freight train comes through around 11:40. Its horn sounds like one long vowel. The whole city hears that horn, each person from a different distance. The rails are the one place out here that is not kidding. Trains do not stop. Every kid in the city has been told.",
    "oldDoings": "Put a penny on the rail and wait for the freight — flatten penny starts it. Wave at Boone in the engine. Stand well back like you were raised to.",
    "doings": "Put a penny on the rail and wait for the freight train. Use the command “flatten penny” to begin. Wave at Boone in the engine. Stand well back, like you were raised to."
  },
  {
    "roomId": "the_airfield",
    "oldDesc": "A grass strip mowed shorter than the field around it, a wind sock you hear working before you find it, and a hangar holding a crop duster that flies and a jump plane that mostly tells stories. Cass Delaney failed retirement in four months and teaches out of a folding chair by the fuel drum.",
    "desc": "The runway is a grass strip, mowed shorter than the field around it. You hear the wind sock working before you find it. A wind sock is a cloth tube that shows which way the wind blows. The hangar holds two planes. The crop duster actually flies. The jump plane is made for skydivers. It mostly tells stories. Cass Delaney failed at retirement in four months. Now Cass teaches out of a folding chair by the fuel drum.",
    "oldDoings": "Ask Cass about flying lessons — local hops, the lake circuit, the night flight over the city. The edge of the world is the view.",
    "doings": "Ask Cass about flying lessons. You can take short local hops, the lake circuit, or the night flight over the city. The edge of the world is the view."
  },
  {
    "roomId": "tandy_orchard",
    "oldDesc": "Eleven rows of apple, four of pear, and one pawpaw at the end that Birdie planted out of spite and will not discuss. The grass between rows is mowed to the exact width of a flatbed. In September this place has a sound you can find from the ring road.",
    "desc": "The orchard has eleven rows of apple trees and four rows of pear. One pawpaw tree stands at the end. Birdie planted the pawpaw out of spite, and she will not discuss it. The grass between the rows is mowed to the exact width of a flatbed truck. In September, the orchard makes a sound you can find from the Ring Road.",
    "oldDoings": "Pick in season. Birdie is somewhere in the rows and will find you before you find her.",
    "doings": "Pick fruit in season. Birdie is somewhere in the rows. She will find you before you find her."
  },
  {
    "roomId": "tandy_stand",
    "oldDesc": "A roadside table under a tin roof, an honor box with a slot worn shiny, and a hand-lettered sign that has said TAKE WHAT YOU NEED, PAY WHAT YOU CAN for longer than anybody can account for. The box is never empty and never full.",
    "desc": "A roadside table sits under a tin roof. The honor box has a slot worn shiny. An honor box trusts you to pay with nobody watching. A hand-lettered sign says TAKE WHAT YOU NEED, PAY WHAT YOU CAN. The sign has said that for longer than anybody can remember. The box is never empty and never full.",
    "oldDoings": "Buy fruit. Pay the honor box, or do not, and live with it.",
    "doings": "Buy fruit. Pay the honor box, or do not. Either way, you live with it."
  },
  {
    "roomId": "the_cider_press",
    "oldDesc": "A barn with one enormous job. The press is older than the barn and was here first — they built around it because moving it was never seriously proposed. Every surface within eight feet is dark and sticky and will be forever.",
    "desc": "This barn has one enormous job. The cider press is older than the barn, and it was here first. Nobody ever seriously suggested moving the press. So the barn was built around it. Every surface within eight feet of the press is dark and sticky, and always will be.",
    "oldDoings": "Press in season. Emmett runs it and lets you help if you do not talk while he is counting.",
    "doings": "Press apples in season. Emmett runs the press. He lets you help if you do not talk while he is counting."
  },
  {
    "roomId": "the_lake_dock",
    "oldDesc": "Six boards out into flat brown water at the far edge of the fields. A rowboat chained to a post, upside down, since before anybody asked. The lake does not have a current and it does not have a name and neither has ever come up.",
    "desc": "The Lake Dock is six boards reaching out into flat brown water. It sits at the far edge of the fields. A rowboat is chained to a post, upside down. The rowboat has been that way since before anybody asked. The lake has no current. It has no name either. Neither one has ever come up in conversation.",
    "oldDoings": "Lake fishing. Nothing here is in a hurry and it is contagious.",
    "doings": "Lake fishing. Nothing here is in a hurry. That feeling is contagious."
  },
  {
    "roomId": "gravewalk_lanterns",
    "oldDesc": "Lanterns in long rows under a sky the color of held breath. Your footsteps arrive a half-second late, like the ground is double-checking. The dead walk here thinned-out and unhurried, and the light does not flicker so much as think.",
    "desc": "Lanterns stand in long rows. The sky above them is the color of a held breath. Your footsteps arrive half a second late, as if the ground is double-checking. The dead walk here. They are thinned out and in no hurry. The lantern light does not really flicker. It thinks.",
    "oldDoings": "Walk the rows. Read the lanterns. Time is politer here and less convincing.",
    "doings": "Walk the rows. Read the lanterns. Time is more polite here. It is also less convincing."
  },
  {
    "roomId": "gravewalk_teahouse",
    "oldDesc": "Steam that rises slower than steam should. The tea is memory-flavored — nobody can explain it better than that, and the regulars have stopped trying. Cups click softly. Conversations here have no skin left in the game, which makes them the best conversations anywhere.",
    "desc": "Steam rises slower than steam should. The tea is memory-flavored. Nobody can explain the flavor better than that. The regulars have stopped trying. Cups click softly. The people at these tables have no skin left in the game. They have nothing left to lose. That makes their conversations the best anywhere.",
    "oldDoings": "Drink the tea. Hear the Gravewalk’s take on ward politics — informed, petty, and free.",
    "doings": "Drink the tea. Hear the Gravewalk’s opinions on ward politics. They are informed, petty, and free."
  },
  {
    "roomId": "gravewalk_switchboard",
    "oldDesc": "A wall of brass jacks and cloth cords, patched and re-patched by ghost operators working in fingerless gloves out of tradition, not cold. Each cord is a thread to somewhere a living person is listening — a bench, a river, a payphone that should not ring. The board hums like it is remembering a song.",
    "desc": "This is a wall of brass jacks and cloth cords. A jack is a socket that a cord plugs into. Ghost operators patch the cords, then patch them again. They wear fingerless gloves out of tradition, not because they are cold. Each cord is a thread to a place where a living person is listening. That place might be a bench, a river, or a payphone that should not ring. The switchboard hums like it is remembering a song.",
    "oldDoings": "Watch the operators work the lines between the wards and here. The 13 bus stops outside on no schedule at all.",
    "doings": "Watch the operators connect the lines between the other wards and the Gravewalk. The number 13 bus stops outside. It keeps no schedule at all."
  }
];

module.exports = { PLAIN_ROOM_TEXT };
