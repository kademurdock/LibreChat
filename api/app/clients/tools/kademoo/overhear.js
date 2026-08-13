/* ── OVERHEARING (2026-08-13, round 9 — rebuilt) ───────────────────────────
 *
 * REBUILD NOTE. Same story as strays.js: a previous session built this, wrote
 * a ledger entry claiming commit e52c25b, and never pushed. Rebuilt from that
 * entry's spec, with its measured answer rates treated as the contract and
 * re-measured at the bottom of this file rather than believed.
 *
 * WHY IT EXISTS — the reframe that mattered, in her words: the standard is
 * Miriani and Cosmic Rage. You say something out loud, the room answers, you
 * meet somebody, and it should be a small shock to find out later they were
 * never a soul. Measured against that, the repeating-lines bug was the SECOND
 * problem. The first was that citizens could not hear an open `say` at all.
 *
 * `talk to <citizen>` is a menu. A room that does not answer you is furniture,
 * and furniture is exactly how a player works out which chars are synths. No
 * amount of good writing on `talk to` covers for it.
 *
 * ── THE FOUR RULES, each one a synth tell if broken ───────────────────────
 *
 * 1. ANSWER WHAT YOU'D KNOW. A librarian does not hold forth on outboard
 *    motors. Not knowing, out loud, is more human than knowing everything —
 *    and it is the single cheapest way to make twenty NPCs feel like twenty
 *    people instead of one database with twenty faces.
 *
 * 2. ONE VOICE AT A TIME. Four citizens answering `hey` in unison is the
 *    tell. The room picks one responder. Everybody else stays quiet, which is
 *    what people in rooms actually do.
 *
 * 3. SILENCE IS A LEGITIMATE ANSWER. Real rooms let things pass. The rates
 *    below are deliberately not 100% — an NPC that answers every single
 *    utterance is as obvious as one that answers none.
 *
 * 4. NEVER THE SAME WORDS TWICE TO THE SAME PERSON. Per-(player, npc) memory,
 *    not global. Two players hearing the same good line is fine; one player
 *    hearing it twice is the moment the world goes flat.
 *
 * COST: zero model calls. Every line here is written. The narrator lane can
 * inhabit any of it later without touching a line of this file — that is why
 * the answers are stored as data and picked by a pure function.
 */

/* ── TOPICS ────────────────────────────────────────────────────────────────
 * A topic is a thing somebody in this city could be an authority on. The
 * regexes are deliberately loose: a player types how a player types, and
 * missing a question is a worse failure than catching a stray one. */
const TOPIC_PATTERNS = {
  food: /\b(eat|eating|ate|food|hungry|starv|coffee|pie|breakfast|lunch|supper|dinner|meal|cook|grill|sandwich|plate)\b/i,
  drink: /\b(drink|beer|bar|whiskey|bourbon|pour|tab|stool|drunk|sober)\b/i,
  water: /\b(boat|boats|water|harbor|harbour|dock|docks|pier|tide|river|lake|ferry|sail|barge|crossing|channel)\b/i,
  fish: /\b(fish(es|ing)?|bait|bit(e|es|ing)|nibble|catch(es|ing)?|caught|pole|tackle|reel|cast(ing)?|hook|crappie|bluegill|perch|catfish)\b/i,
  books: /\b(book|books|read|reading|library|archive|record|records|chronicle|paper|file|filed|history|wrote|written)\b/i,
  hair: /\b(hair|haircut|barber|shave[nd]?|shaving|beard|trim(s|med|ming)?)\b/i,
  /* Suffixes matter more than they look. `\bhurt\b` does not match "hurts",
    * so "my arm hurts, where do I go" scored as directions only and routed to
    * the librarian instead of the doctor. Every verb in these tables now
    * carries its own endings. */
  health: /\b(sick|ill|hurts?|hurting|pains?|painful|bleed(s|ing)?|blood|doctor|clinic|hospital|medicine|fever|coughs?|coughing|broken|aches?|aching|dying|die[sd]?|injur\w*|wound\w*)\b/i,
  money: /\b(money|coins?|pay|paid|costs?|price|how much|cheap|expensive|afford|loan|owes?|debt|bank|account|savings?)\b/i,
  pawn: /\b(pawn|sell|selling|sold|buy|buying|trade|worth|value|junk|antique|ring|watch)\b/i,
  /* `engine` used to be here and it sent "my engine won't start" to the rail
   * foreman instead of the man who repairs outboards. A boat engine is not a
   * locomotive; the words that mean TRAIN are the ones that belong here. */
  trains: /\b(trains?|rails?|freight|tracks?|crossing|switchyard|locomotive|boxcar|horn|whistle)\b/i,
  law: /\b(police|cop|cops|arrest|crime|stole|stolen|steal|thief|fight|trouble|law|legal|illegal|jail)\b/i,
  court: /\b(court|judge|trial|hearing|case|sue|testimony|swear|sentence|verdict)\b/i,
  paperwork: /\b(form|forms|permit|license|application|apply|office|bureau|stamp|signature|complaint|complain|paperwork)\b/i,
  /* `find` is NOT here on purpose. "how do I find the ferry" is a directions
   * question, and letting it reach Opal got her answering a map question with
   * a philosophy of lost property. */
  lost: /\b(lost|lose|missing|misplaced|dropped|left it behind|stray|strays|lost and found)\b/i,
  kids: /\b(kid|kids|child|children|baby|babies|school|young|orphan|son|daughter|boy|girl)\b/i,
  /* `somebody` and `anybody` used to be here and they were a measurement bug
   * with a costume on: "does ANYBODY know where the ferry is" scored as a
   * neighbours question, so every unknown question in the rate harness came
   * back known and question_unknown measured 0.62 against a contract of 0.51.
   * Worse in play than in the harness — Ruth-Ann answering a map question
   * with her philosophy of looking after the block is exactly the wrongness
   * rule 1 exists to prevent. Loose patterns are fine; patterns that match
   * ordinary question SCAFFOLDING are not. */
  neighbors: /\b(neighbor|neighbour|neighbors|neighbours|help|helping|helped|stoop|porch|block|folks|community|look after)\b/i,
  flying: /\b(plane|planes|fly|flying|flight|airfield|pilot|wing|sky|land|landing)\b/i,
  growing: /\b(garden(s|ing)?|grow(s|ing|n)?|plant(s|ed|ing)?|seeds?|crops?|tomato\w*|beans?|corn|greens|dirt|soil|harvest\w*|forag\w*|orchard|trees?|apples?|pears?|pawpaws?|fruit|cider|pick(s|ing)?|windfall|prun\w*)\b/i,
  /* Round 9: the Millrace had a mechanic and no way to ask him anything. */
  machines: /\b(motors?|engines?|outboard|mechanic|repairs?|repairing|fix(es|ing|ed)?|machine|wrench|garage|carburet\w*|spark plug|tune[- ]?up|gasket|propeller)\b/i,
  weather: /\b(weather|rain|raining|storm|snow|fog|cold|hot|heat|wind|sky|sun|freeze|ice)\b/i,
  directions: /\b(where|which way|how do i get|how to get|find my way|lost|direction|road to)\b/i,
  work: /\b(job|jobs|work|working|hire|hiring|shift|boss|union|wage|wages|fired|quit)\b/i,
  music: /\b(song|songs|music|radio|station|band|play|playing|sing|singing|record|dance)\b/i,
  death: /\b(dead|death|died|dying|funeral|grave|bury|buried|ghost|gone|passed)\b/i,
};

/* NOT ALL TOPICS ARE WORTH THE SAME. `directions` fires on the word "where",
 * which is in most location questions ever typed, so an unweighted score let
 * the ferry captain beat the cook to "where can I get something to eat" —
 * both scored one topic, and the tie broke wrong. A topic that matches
 * question scaffolding is a weak signal; a topic that matches subject matter
 * is a strong one. Weights, not exclusions, because the captain SHOULD still
 * answer a pure "where is X" when no one better is standing there. */
const TOPIC_WEIGHT = { directions: 0.4, weather: 0.6, neighbors: 0.7, work: 0.8 };
function weightOf(topic) {
  return TOPIC_WEIGHT[topic] === undefined ? 1 : TOPIC_WEIGHT[topic];
}

/** Which topics does this sentence touch? */
function topicsIn(text) {
  const out = [];
  for (const [t, re] of Object.entries(TOPIC_PATTERNS)) if (re.test(text)) out.push(t);
  return out;
}

/* ── UTTERANCE KIND ────────────────────────────────────────────────────────
 * Four shapes, four different social obligations. A greeting is nearly always
 * returned. A question about nothing anybody knows is answered half the time,
 * because half the time somebody says "no idea" and half the time nobody
 * bothers. Muttering to yourself is answered rarely, and that is correct. */
const GREETING = /^\s*(hi|hey|hello|yo|howdy|morning|good morning|afternoon|good afternoon|evening|good evening|hiya|sup|what's up|whats up|greetings|hola)\b/i;
const COURTESY = /\b(thank you|thanks|thankya|appreciate it|please|sorry|excuse me|pardon|beg your pardon|much obliged|bless you|no worries|my bad)\b/i;
const QUESTION = /\?\s*$|^\s*(who|what|when|where|why|how|is there|are there|does anybody|do you|can you|could you|would you|anybody know|anyone know|any idea|got any)\b/i;

function kindOf(text) {
  const t = String(text || '').trim();
  if (!t) return 'idle';
  if (GREETING.test(t)) return 'greeting';
  if (QUESTION.test(t)) return 'question';
  if (COURTESY.test(t)) return 'courtesy';
  return 'idle';
}

/* The contract. These are the numbers the ledger promises; `measureRates()`
 * at the bottom re-derives them from this table so the two can never drift. */
const ANSWER_RATE = {
  greeting: 0.87,
  courtesy: 0.90,
  question_known: 0.86,
  question_unknown: 0.51,
  idle: 0.10,
};

/* ── THE VOICES ────────────────────────────────────────────────────────────
 * knows:    topics this person is an authority on.
 * answers:  what they say when the topic is theirs. Their own voice, always.
 * greet:    how they say hello. A greeting is the most-heard line in the game
 *           and a shared pool for it would out everybody in one afternoon.
 * shrug:    how they say they don't know — the most character-revealing line
 *           any of these people have, which is why nobody shares one.
 */
const VOICES = {
  pat: {
    knows: ['food', 'drink', 'neighbors', 'work'],
    greet: ['"Sit down or don\'t, but decide."', '"Coffee\'s on. It\'s bad. You know that."', 'Pat lifts the spatula an inch. That\'s the greeting.'],
    answers: {
      food: ['"Eggs are eggs. Pie\'s good. Anybody tells you different is selling something."', '"You want it hot or you want it fast. Pick one and I\'ll pretend I can do both."'],
      drink: ['"Coffee till six, then Dez\'s. I don\'t compete with a man who has ice."'],
      neighbors: ['"Everybody in this ward comes through that door eventually. That\'s not wisdom, that\'s just the door."'],
      work: ['"Work is what you do between meals. Don\'t let anybody make it the other thing."'],
    },
    shrug: ['"Couldn\'t tell you. Ask somebody who sits down."', '"Not my counter, not my problem."'],
  },
  merle: {
    knows: ['water', 'fish', 'work', 'neighbors'],
    greet: ['"Hey — hey. I owe you one, right? I owe somebody one."', 'Merle nods around whatever he\'s eating.'],
    answers: {
      water: ['"Tide\'s doing what tide does. You want the real answer, ask Marsh, she reads it like a page."', '"Anything that comes off a boat come off a boat for a reason. Sometimes the reason is nothing."'],
      fish: ['"Pier Seven before the sun\'s all the way up. After that you\'re just standing outside."'],
      work: ['"There\'s always a shift. Whether there\'s always pay is a different sentence."'],
      neighbors: ['"You need a hand, you say so out loud. That\'s the whole system. People overcomplicate it."'],
    },
    shrug: ['"Man, I just carry things."', '"Above my pay grade, and my pay grade is boxes."'],
  },
  ines: {
    knows: ['books', 'court', 'paperwork', 'death', 'directions'],
    greet: ['"Quietly, if you can manage it."', '"Ah. You. Come in."'],
    answers: {
      books: ['"Everything that happened is written down. Whether it\'s written down TRUE is a separate errand."', '"The chronicle is public record. Your reading habits are between you and me. Mostly me."'],
      court: ['"Night court keeps better records than day court, and I will not be elaborating."'],
      paperwork: ['"Wendell\'s bureau invents forms. I file the ones that survive. Very few do."'],
      death: ['"Everyone here ends up in the stacks eventually. It\'s the kindest filing system we have."'],
      directions: ['"Out, left, and follow the noise. This city is loud in useful ways."'],
    },
    shrug: ['"I don\'t know, and I dislike that enormously. Give me a week."', '"Not filed. Which means either nobody wrote it down or somebody didn\'t want it written."'],
  },
  dez: {
    knows: ['drink', 'music', 'neighbors', 'work'],
    greet: ['"There they are."', '"Sit anywhere. The good stool\'s a myth Pat started."'],
    answers: {
      drink: ['"I pour what you ask for and I don\'t comment. That\'s the job and the ethics."', '"You want the cheap thing, it\'s honest. You want the good thing, it\'s also honest, just louder."'],
      music: ['"The Band plays whatever\'s left after the tower eats the signal. Some nights that\'s better."'],
      neighbors: ['"Everybody tells a bartender everything. I\'ve got about forty secrets and no interest in any of them."'],
      work: ['"Night work does something to your Tuesdays. You get used to it or you don\'t."'],
    },
    shrug: ['"Couldn\'t say, and if I could I probably shouldn\'t."', '"That\'s a Pat question. Different building, different expertise."'],
  },
  ruthann: {
    knows: ['food', 'neighbors', 'kids', 'growing', 'lost'],
    greet: ['"There you are. You eaten?"', '"Come up on the stoop. You don\'t have to stay."'],
    answers: {
      food: ['"There\'s a plate. There\'s always a plate. Don\'t make a speech about it, just eat."'],
      neighbors: ['"You look after the block, the block looks after you. It is not more complicated than that and people keep making it more complicated."'],
      kids: ['"Half the kids on Gully Road have eaten at my table and not one of them\'s been asked to explain why."'],
      growing: ['"Poke\'s got to be boiled three times. THREE. I will not say it again, I will just keep saying it."'],
      lost: ['"Somebody\'s always looking for something down here. Usually it\'s under something else."'],
    },
    shrug: ['"Oh, honey, I don\'t know. Ask Ray, he keeps up with things."', '"That\'s past my fence."'],
  },
  levi: {
    knows: ['hair', 'neighbors', 'work', 'music'],
    greet: ['"Chair\'s open."', '"Look who it is. Sit, sit."'],
    answers: {
      hair: ['"Everybody comes in describing somebody else\'s head. Then they leave with their own. That\'s the trade."', '"Takes fifteen minutes. The other forty is what you\'re actually here for."'],
      neighbors: ['"I hear everything in this chair and I repeat about a tenth of it. The good tenth."'],
      work: ['"A trade is a thing that still works when the money\'s strange."'],
      music: ['"Radio stays on. It\'s not for me, it\'s so the room has a floor."'],
    },
    shrug: ['"Now that I couldn\'t tell you, and I hear most things."'],
  },
  doc: {
    knows: ['health', 'death', 'neighbors'],
    greet: ['"You hurt, or you visiting?"', 'Doc looks you over once, fast, the way Doc looks at everybody.'],
    answers: {
      health: ['"Come in before it\'s bad. Everybody comes in after it\'s bad. I have said this eleven thousand times."', '"I can fix most of what this ward does to itself. Not all. Come early."'],
      death: ['"I lose some. You\'d worry about me if I said otherwise."'],
      neighbors: ['"Nobody pays what it costs here and nobody\'s turned away. Those two facts are load-bearing."'],
    },
    shrug: ['"Not medicine. Not my lane."', '"I know bodies. Ask somebody who knows people."'],
  },
  hock: {
    knows: ['pawn', 'money', 'lost'],
    greet: ['"Buying or selling. There\'s no third thing."', '"Mm. You."'],
    answers: {
      pawn: ['"Everything in here is worth exactly what somebody needed that day. That is not cynicism, that is the definition."', '"I\'ll give you a fair price and you\'ll be unhappy about it. Fair usually is."'],
      money: ['"Money is the least interesting thing anybody brings me."'],
      lost: ['"Things end up here. That\'s not the same as stolen and I check."'],
    },
    shrug: ['Hock looks at you until you go ask somebody else.', '"No."'],
  },
  boone: {
    knows: ['trains', 'machines', 'work', 'weather'],
    greet: ['"Watch the rail. Say it back to me."', '"You\'re early or you\'re late. Nobody\'s ever on time out here."'],
    answers: {
      machines: ['"Rail machinery is honest. It is too big to lie to you about what it is doing."'],
      trains: ['"Eleven forty, every night, and if it\'s not eleven forty something\'s wrong somewhere else."', '"You hear the horn change pitch, it\'s already too late to be standing where you\'re standing."'],
      work: ['"I take one student a year. One. And I don\'t pick by who asks loudest."'],
      weather: ['"Rain on the rail is a different job than dry rail. Everything is."'],
    },
    shrug: ['"That\'s town business. I do track."'],
  },
  marsh: {
    knows: ['water', 'fish', 'weather', 'directions'],
    greet: ['"You crossing, or standing?"', '"Captain. Or Marsh. Not ma\'am."'],
    answers: {
      water: ['"The channel runs deeper on the Sweetwater side and every summer somebody re-learns that."', '"I read the water the way Ines reads a spine. It\'s the same skill in a wetter building."'],
      fish: ['"Deep water off the breakwater. Take a real pole or take a real disappointment."'],
      weather: ['"Fog\'s coming when the horn sounds close and you can\'t see the thing making it."'],
      directions: ['"Hook to Sweetwater, every hour I feel like it. That\'s the whole timetable and it has never once been written down."'],
    },
    shrug: ['"Dry land. Not mine."'],
  },
  reed: {
    knows: ['kids', 'paperwork', 'lost', 'neighbors'],
    greet: ['"Miss Reed. And you are?"', '"Sit up straight, it helps. I don\'t know why."'],
    answers: {
      kids: ['"Every child that comes through this office leaves with a name and a place. I have never once failed at that and I will not start."', '"They are not cases. They are people who are currently small."'],
      paperwork: ['"The forms exist so nobody can be lost quietly. That\'s the only reason forms should ever exist."'],
      lost: ['"Lost child is a different drawer than lost dog. Opal and I have an understanding."'],
      neighbors: ['"This ward raises its own. Loudly, and with opinions."'],
    },
    shrug: ['"Outside my office. Which is a thing I say too often lately."'],
  },
  odessa: {
    knows: ['law', 'court', 'neighbors', 'lost'],
    greet: ['"Sergeant Vann. Evening."', 'Odessa nods, and it takes exactly as long as it needs to.'],
    answers: {
      law: ['"Most of what people call crime down here is two folks who needed the same thing on the same day."', '"I write it down. What happens after that isn\'t up to me and I\'ve made peace with about half of it."'],
      court: ['"Night court is faster and stranger. Take the night one."'],
      neighbors: ['"The Hook polices itself first and calls me second. That\'s working, mostly."'],
      lost: ['"File it with Opal. She finds things. I mostly find people, and only when they want finding."'],
    },
    shrug: ['"Not a police matter. Which is usually good news."'],
  },
  wendell: {
    knows: ['paperwork', 'court', 'money'],
    greet: ['"Take a number. There is no number. Take one anyway."', '"Frist. Small Complaints. Emphasis wherever you like."'],
    answers: {
      paperwork: ['"There is a form. There is always a form. Whether it does anything is a philosophical question the Bureau does not entertain."', '"Fill it out in ink. Pencil suggests you might change your mind, and the Bureau finds that upsetting."'],
      court: ['"Small complaints stay small if you file early. Large ones started small and were ignored."'],
      money: ['"My cousin runs the record store and does better than I do. I have chosen not to examine that."'],
    },
    shrug: ['"Not a complaint I can process. You could file it anyway. People do."'],
  },
  opal: {
    knows: ['lost', 'paperwork', 'neighbors'],
    greet: ['"Lost something, or found something?"', '"Opal. Third drawer\'s the interesting one."'],
    answers: {
      lost: ['"Lost dog, found dog, same drawer. People find that funny until it\'s their dog."', '"Everything comes back eventually. Not always to the same person, but back."'],
      paperwork: ['"Wendell files complaints. I file objects. Objects are more honest."'],
      neighbors: ['"You\'d be amazed what people hand in. And who."'],
    },
    shrug: ['"Not in any drawer I keep."'],
  },
  constance: {
    knows: ['money', 'paperwork', 'court'],
    greet: ['"Mrs. Ledger-Pryce. Yes, really."', '"You have an appointment. Everyone has an appointment."'],
    answers: {
      money: ['"A bank is a promise with a building around it. Ours has held, which is more than the bell tower can say."', '"I lend to people, not to plans. Plans lie."'],
      paperwork: ['"Signed, dated, witnessed. Two of those are optional and I will not tell you which."'],
      court: ['"Debt goes to day court. Everything interesting goes to night."'],
    },
    shrug: ['"Not a banking matter, and I am relieved."'],
  },
  oleander: {
    knows: ['money', 'pawn', 'work'],
    greet: ['"Fitch. The Exchange. Mind the floor, it\'s original."', '"What are we valuing today?"'],
    answers: {
      money: ['"A mark is worth what the room agrees it\'s worth, and the room changes its mind at eleven."'],
      pawn: ['"Hock buys need. I trade want. It\'s the same building trade with better lighting."'],
      work: ['"Half this city thinks the Exchange is a scam. The other half works here."'],
    },
    shrug: ['"No market in that. Yet."'],
  },
  pham: {
    knows: ['court', 'law', 'death'],
    greet: ['"Court\'s in session when I say it is. Sit."', '"Your Honor is fine. Pham is better."'],
    answers: {
      court: ['"Night court exists because the truth comes out easier at two in the morning. That is not a joke and I have the docket to prove it."', '"I have never once been convinced by somebody who prepared. Prepared is a tell."'],
      law: ['"The law is a floor, not a ceiling. People keep mistaking it for instructions."'],
      death: ['"I have signed a great many things. The ones about the dead take longest."'],
    },
    shrug: ['"Not before this bench."'],
  },
  littleray: {
    knows: ['neighbors', 'law', 'money', 'music'],
    greet: ['"Evening." Polite, careful, eyes doing the work.', '"Hey. You good?"'],
    answers: {
      neighbors: ['"I know who\'s on this corner and who ought to be. Aunt Ruth taught me the difference."'],
      law: ['"I don\'t make trouble. Trouble\'s got a schedule and I know it, that\'s all."'],
      money: ['"Money down here moves in small amounts and long memories."'],
      music: ['"The Band after midnight is the only radio worth the electricity."'],
    },
    shrug: ['"Couldn\'t say." And he could, and he won\'t, and you both know it.'],
  },
  cass: {
    knows: ['flying', 'weather', 'work', 'directions'],
    greet: ['"Cass. Retired, allegedly."', '"You here to fly or here to watch?"'],
    answers: {
      flying: ['"Anybody can be taught to fly. Almost nobody can be taught to quit while they\'re ahead."', '"Thirty years on the line and the part I miss is the ten minutes before dawn on the ramp."'],
      weather: ['"You learn sky before you learn airplane. Everybody does it backwards and everybody pays for it."'],
      work: ['"I take students. I take them slow. The slow ones live."'],
      directions: ['"From the air this whole city is nine neighborhoods pretending not to touch."'],
    },
    shrug: ['"Ground problem. I was never good at those."'],
  },
  chike: {
    knows: ['health', 'death', 'kids', 'paperwork'],
    greet: ['"Dr. Chike. Day shift, which tells you something about my luck."', '"Are you well? Actually well?"'],
    answers: {
      health: ['"Mercy takes everyone. That is a policy and it is expensive and it is not up for discussion."', '"Come in early. Doc says it too. We are both saying it to the same ward and neither of us is winning."'],
      death: ['"Pruitt has nights. Nights are harder and he\'s better at them than I am."'],
      kids: ['"Miss Reed brings me children who are fine and worried they aren\'t. That\'s the best appointment of my week."'],
      paperwork: ['"A hospital runs on forms and I resent every one of them individually."'],
    },
    shrug: ['"Not medicine. Ask somebody whose building has fewer forms."'],
  },

  /* ── Round 9: the Cutlers and the Tandys ─────────────────────────────── */
  marva: {
    knows: ['fish', 'water', 'money', 'weather'],
    greet: ['"Morning. Pole\'s in the barrel."', '"You buying, or looking?"', 'Marva looks up, then back down. That is the greeting and it is not unfriendly.'],
    answers: {
      fish: ['"Breakwater on the falling tide. That is the whole secret and everybody ignores it."', '"A bare hook still fishes. It fishes badly. But it fishes, and I have watched men learn more from a bare hook than a good one."'],
      water: ['"Harbor\'s one thing, deep water\'s another, and people who cannot tell you which they are standing over should not be standing over either."'],
      money: ['"Pole\'s six. Bait\'s two. I have not raised either in eleven years and I am not going to explain why."'],
      weather: ['"Falling glass and the fish know before you do. Watch what the gulls quit doing."'],
    },
    shrug: ['"Not a Shack question."', '"Ask Marsh. She goes further out than I do."'],
  },
  royce: {
    knows: ['machines', 'work', 'water', 'money'],
    greet: ['"Yeah." He does not stop what he is doing.', '"Bring it in, I\'ll look at it."'],
    answers: {
      machines: ['"Bring it in, I\'ll look at it. Don\'t bring it in and tell me what\'s wrong with it — half of what people are certain about is the other half\'s fault."', '"An outboard is a simple thing that has been made complicated by people who have to sell it every year."'],
      work: ['"Bring it in and don\'t tell me what\'s wrong with it. Half of what people are sure about is the other half\'s fault."', '"I fit parts. The Shack sells them. Different trade." He does not look up.'],
      water: ['"Everything that comes off that lake has water where it shouldn\'t. Every single one, and they all act surprised."'],
      money: ['"You pay when it runs. Not before, and I don\'t chase anybody."'],
    },
    shrug: ['"Don\'t know." And that is the whole sentence.', '"Not my end of it."'],
  },
  birdie: {
    knows: ['growing', 'food', 'weather', 'kids'],
    greet: ['"There you are. I saw you from row six."', '"Mind the windfall, it turns an ankle."'],
    answers: {
      growing: ['"Windfall is not waste, windfall is cider. Everything out here has a second job."', '"That pawpaw at the end is none of your business and I will tell you all about it."'],
      food: ['"Take what you need, pay what you can. That sign is older than you and the box has never once been empty."'],
      weather: ['"A hard frost late enough is a favor. Early enough and it\'s a funeral. Same frost."'],
      kids: ['"Miss Reed sends the Children\'s Office out every September and they out-pick every adult who has ever come out here."'],
    },
    shrug: ['"Past the fence line, past my knowing."', '"Ruth-Ann would know. She knows the things I don\'t and it is aggravating."'],
  },
  emmett: {
    knows: ['work', 'drink', 'growing'],
    greet: ['"Give me a second." He is counting. He will give you the second.', 'Emmett lifts his chin an inch and keeps counting.'],
    answers: {
      work: ['"Press wants apples and patience. It has got the apples."', '"You can help. Don\'t talk while I\'m counting and you can help."'],
      drink: ['"Dez takes the October run entire. Every barrel, every year, and he has never once haggled about it."'],
      growing: ['"Mom knows the trees. I know what comes out of them. We have not needed to overlap."'],
    },
    shrug: ['"Couldn\'t say." He goes back to counting.'],
  },
  junie: {
    knows: ['growing', 'kids', 'food'],
    greet: ['"Hi!" — from somewhere above you.', '"You looking for Grandma? She\'s in the rows."'],
    answers: {
      growing: ['"You want a good one you go high. Everybody picks what they can reach and then says it was a bad year."', '"I know every tree by the bark. That\'s not bragging, that\'s just true."'],
      kids: ['"Dad says when I\'m fourteen. I did the math on that and it is not soon."'],
      food: ['"Row four is easy. Grandma says row four because she thinks I\'ll fall out of row nine."'],
    },
    shrug: ['"I don\'t know that one." A beat. "I could find out."'],
  },
};

/* ── GENERIC POOLS ─────────────────────────────────────────────────────────
 * For citizens with no VOICES entry, and for topics nobody in the room owns.
 * Kept small and plain ON PURPOSE: a generic line should read as somebody
 * being unremarkable, not as the game reaching for something. */
const GENERIC = {
  greet: ['nods.', 'lifts a hand.', 'says something back that amounts to hello.', 'glances up, then back down.'],
  courtesy: ['"Sure."', '"Any time."', '"Don\'t mention it."', 'waves it off.'],
  shrug: ['"No idea, sorry."', '"Couldn\'t tell you."', 'shakes their head.', '"Wish I knew."', '"Ask around, somebody will."'],
};

/* ── HASHING + MEMORY ──────────────────────────────────────────────────────
 * Rule 4 needs to know which lines this player has heard from THIS npc. We
 * store short hashes rather than whole sentences: the memory is a fixed size
 * per pair, it survives rewording, and it never turns a char document into a
 * transcript. */
function hashLine(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (Math.abs(h) % 1000000).toString(36);
}
const MEMORY_PER_NPC = 12;

/** Pick from `pool`, preferring anything not in `heard`. Falls back to the
 *  full pool only when they have genuinely said all of it — at which point a
 *  repeat is honest, because a person with four things to say does eventually
 *  say one of them again. */
function pickUnheard(pool, heard, rng = Math.random) {
  if (!pool || !pool.length) return null;
  const fresh = pool.filter((l) => !heard.includes(hashLine(l)));
  if (fresh.length) return fresh[Math.floor(rng() * fresh.length)];
  /* Pool exhausted. Falling back to the WHOLE pool here was the original sin
   * dressed differently: it produced back-to-back repeats the moment somebody
   * greeted the same person four times, which is the exact complaint in the
   * ledger. At minimum, never the line they just heard. A person with three
   * things to say does eventually say one again — but never twice running,
   * because nobody does that. */
  const last = (heard || [])[0];
  const notLast = pool.filter((l) => hashLine(l) !== last);
  const from = notLast.length ? notLast : pool;
  return from[Math.floor(rng() * from.length)];
}

/* ── THE ANSWER ────────────────────────────────────────────────────────────
 *
 * @param {object} npc      { id, name }
 * @param {string} utterance what the player said
 * @param {object} opts     { heard: [hashes], rng }
 * @returns {{ line, topic, hash } | null}   null means this one stays quiet
 */
function overhearReply(npc, utterance, opts = {}) {
  const rng = opts.rng || Math.random;
  const heard = opts.heard || [];
  const v = VOICES[npc.id] || null;
  const kind = kindOf(utterance);
  const topics = topicsIn(utterance);
  const mine = v ? topics.filter((t) => v.knows.includes(t)) : [];

  /* Rate first. Silence is rule 3 and it is checked before anything is
   * chosen, so a quiet NPC costs nothing. */
  let rate;
  if (kind === 'greeting') rate = ANSWER_RATE.greeting;
  else if (kind === 'courtesy') rate = ANSWER_RATE.courtesy;
  else if (kind === 'question') rate = mine.length ? ANSWER_RATE.question_known : ANSWER_RATE.question_unknown;
  else rate = mine.length ? ANSWER_RATE.question_known : ANSWER_RATE.idle;
  if (rng() > rate) return null;

  let line = null; let topic = null;

  if (kind === 'greeting') {
    line = pickUnheard(v && v.greet, heard, rng);
    if (!line) line = `${npc.name} ${pickUnheard(GENERIC.greet, heard, rng)}`;
  } else if (kind === 'courtesy' && !mine.length) {
    line = pickUnheard(GENERIC.courtesy, heard, rng);
  } else if (mine.length) {
    /* Rule 1, the good half: they know this. Pick the topic they'd lead with
     * — the first one they list, not the first one the player typed, because
     * a barber asked about hair AND weather talks about hair. */
    topic = mine.slice().sort((a, b) => (weightOf(b) - weightOf(a))
      || (v.knows.indexOf(a) - v.knows.indexOf(b)))[0];
    line = pickUnheard(v.answers[topic], heard, rng);
  }

  if (!line) {
    /* Rule 1, the half that matters more: they don't know, and they say so in
     * their own words. This is the branch that makes twenty people out of a
     * database, so it gets a real line whenever the person has one. */
    line = pickUnheard(v && v.shrug, heard, rng) || pickUnheard(GENERIC.shrug, heard, rng);
    topic = null;
  }
  return { line, topic, hash: hashLine(line) };
}

/* ── RULE 2: ONE VOICE ─────────────────────────────────────────────────────
 * Given everybody present, decide who answers. Whoever actually knows the
 * subject wins; ties and total ignorance break at random, because in a real
 * room the person who speaks up is not the best-qualified one, it's whoever
 * felt like it. */
function chooseResponder(npcs, utterance, rng = Math.random) {
  if (!npcs || !npcs.length) return null;
  const topics = topicsIn(utterance);
  const scored = npcs.map((n) => {
    const v = VOICES[n.id];
    const known = v ? topics.filter((t) => v.knows.includes(t)).reduce((a, t) => a + weightOf(t), 0) : 0;
    return { npc: n, score: known + (v ? 0.5 : 0) };
  });
  const best = Math.max(...scored.map((s) => s.score));
  /* Float scores, so ties compare with a tolerance rather than ===. */
  const top = scored.filter((s) => Math.abs(s.score - best) < 1e-9);
  return top[Math.floor(rng() * top.length)].npc;
}

function rememberLine(heard, hash) {
  const next = [hash, ...(heard || []).filter((h) => h !== hash)];
  return next.slice(0, MEMORY_PER_NPC);
}

/* ── MEASUREMENT ───────────────────────────────────────────────────────────
 * The ledger publishes answer rates. A published number that nobody can
 * re-derive is how the last entry in that file went wrong. This runs the real
 * function over real utterances and reports what actually happens. */
function measureRates(runs = 400) {
  const SAMPLES = {
    greeting: ['hey', 'morning', 'hello there', 'hi'],
    courtesy: ['thank you', 'thanks, appreciate it', 'sorry about that'],
    question_known: ['where can I get something to eat?', 'anybody know about the boats?', 'what happened in court?'],
    question_unknown: ['does anybody know a good name for a horse?', 'what is the airspeed of a swallow?'],
    idle: ['just talking to myself', 'mm', 'well then'],
  };
  const npcs = Object.keys(VOICES).map((id) => ({ id, name: id }));
  const out = {};
  for (const [label, texts] of Object.entries(SAMPLES)) {
    let answered = 0, total = 0;
    for (let i = 0; i < runs; i++) {
      for (const t of texts) {
        const who = label.startsWith('question_known')
          ? chooseResponder(npcs, t)
          : npcs[Math.floor(Math.random() * npcs.length)];
        total++;
        if (overhearReply(who, t, { heard: [] })) answered++;
      }
    }
    out[label] = +(answered / total).toFixed(3);
  }
  return out;
}

module.exports = {
  TOPIC_PATTERNS, TOPIC_WEIGHT, weightOf, topicsIn, kindOf, ANSWER_RATE, VOICES, GENERIC,
  hashLine, pickUnheard, overhearReply, chooseResponder, rememberLine,
  MEMORY_PER_NPC, measureRates,
};
