/* REVERIE LIFE — skills (Sep 6 2026).
 *
 * Ten skills, ten levels each. XP comes from doing the thing, multiplied by
 * mood; a level-up is announced once and lands in the room so people can
 * congratulate you (or not). Levels gate recipes, unlock better outcomes at
 * the lanes and on the water, and change how citizens talk to you. Skills
 * never decay. Nobody forgets how to fish. */

const SKILLS = {
  cooking:  { name: 'Cooking',  titles: ['burns toast', 'fries an egg', 'home cook', 'short-order', 'line cook', 'sure hand', 'the good plates', 'people ask for seconds', 'Pat takes notes', 'the best table in the city'] },
  fishing:  { name: 'Fishing',  titles: ['tangles line', 'catches weeds', 'catches dinner', 'knows the Bite', 'reads the water', 'the Shack regular', 'Marva’s pick', 'the deep-water hand', 'the lake is yours', 'legend of Pier Seven'] },
  charm:    { name: 'Charm',    titles: ['mumbles', 'says hello', 'easy company', 'gets the joke', 'gets the room', 'the one people wait for', 'talks their way in', 'talks their way out', 'the Salon fears you', 'the whole city knows your name'] },
  handy:    { name: 'Handy',    titles: ['hits thumb', 'tightens a bolt', 'fixes a chair', 'fixes a bike', 'fixes an outboard', 'the Garages hire you', 'rebuilds engines', 'Royce nods at you', 'anything with a motor', 'built the bandshell twice'] },
  garden:   { name: 'Garden',   titles: ['kills a cactus', 'keeps basil alive', 'a real tomato', 'a row that comes up', 'a plot that feeds people', 'Ruth-Ann trades with you', 'the plots defer to you', 'the orchard takes advice', 'green thumbs both hands', 'the Greenhouse is yours'] },
  music:    { name: 'Music',    titles: ['hums off-key', 'carries a tune', 'three chords', 'a full song', 'a set at Dez’s', 'the bandshell asks', 'people stop walking', 'the Band plays your tape', 'the whole bar sings back', 'a name on Line Street'] },
  fitness:  { name: 'Fitness',  titles: ['winded', 'climbs the Stairs', 'climbs them twice', 'lifts crates', 'runs the Ring Road', 'the Union Hall steps are easy', 'holds your own', 'nobody starts with you', 'the docks want you', 'built like Merle'] },
  hustle:   { name: 'Hustle',   titles: ['gets hustled', 'knows a guy', 'haggles', 'gets a deal', 'reads a room', 'the Parlor pays out', 'Hock respects you', 'Little Ray nods', 'the corner’s quiet about you', 'you own the dice'] },
  learning: { name: 'Learning', titles: ['skims', 'reads the sign', 'reads a chapter', 'reads a shelf', 'Ines saves you a seat', 'knows the chronicle', 'knows the Archive', 'wins every argument at Levi’s', 'knows who is buried where', 'the Archive asks you'] },
  care:     { name: 'Care',     titles: ['means well', 'shows up', 'holds a hand', 'sits up with somebody', 'the clinic knows you', 'Doc hands you gloves', 'the person people call', 'raised somebody right', 'the whole block leans on you', 'Ruth-Ann’s equal'] },
};
const LEVEL_XP = [10, 25, 50, 90, 140, 210, 300, 420, 580, 800]; // xp needed to REACH level 1..10 (index = level-1)

function levelOf(xp) {
  let lvl = 0;
  for (let i = 0; i < LEVEL_XP.length; i++) if (xp >= LEVEL_XP[i]) lvl = i + 1;
  return lvl;
}
function titleOf(skill, xp) {
  const lvl = levelOf(xp);
  const s = SKILLS[skill];
  return lvl === 0 ? 'untried' : s.titles[Math.min(lvl, 10) - 1];
}
function nextAt(xp) {
  const lvl = levelOf(xp);
  return lvl >= 10 ? null : LEVEL_XP[lvl];
}

/** Returns { xp, level, gained, leveled } — the caller writes it and speaks if `leveled`. */
function gain(skills, skill, base, mult = 1) {
  const cur = (skills && skills[skill]) || 0;
  const before = levelOf(cur);
  const gained = Math.max(1, Math.round(base * mult));
  const xp = cur + gained;
  const level = levelOf(xp);
  return { xp, level, gained, leveled: level > before };
}

function summary(skills) {
  const rows = Object.entries(SKILLS)
    .map(([k, s]) => ({ key: k, name: s.name, xp: (skills && skills[k]) || 0 }))
    .map((r) => ({ ...r, level: levelOf(r.xp), title: titleOf(r.key, r.xp), next: nextAt(r.xp) }));
  return rows;
}

function summaryLine(skills) {
  const rows = summary(skills).filter((r) => r.level > 0).sort((a, b) => b.level - a.level);
  if (!rows.length) return 'No skills yet. Everything you do here teaches you something.';
  return rows.map((r) => `${r.name} ${r.level} (${r.title})`).join(', ') + '.';
}

module.exports = { SKILLS, LEVEL_XP, levelOf, titleOf, nextAt, gain, summary, summaryLine };
