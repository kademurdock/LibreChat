/* REVERIE LIFE — the life tick (Sep 6 2026).
 *
 * Rides the same throttle idea as the world tick: called on every command,
 * does work at most once a minute, and only the work the calendar owes.
 * Rent comes due. Children grow up, go to school, get hungry, and Miss Reed
 * checks in. Marks fade. Rumors cool off. Adopted pets stay home. */
const { MooRoom, MooChar, MooItem, emit, tell, worldClock, daysBetween, pick } = require('./ctx');
const { MooRumor } = require('~/models/kadeMooLife');

let lastAt = 0;
async function run() {
  const now = Date.now();
  if (now - lastAt < 60 * 1000) return;
  lastAt = now;
  await Promise.all([rent(now), children(now), marks(now), rumors(now)]);
}

async function rent(now) {
  const homes = await MooRoom.find({ 'props.home.rentDue': { $lte: now }, 'props.home.owned': { $ne: true } }).lean();
  for (const h of homes) {
    const home = h.props.home;
    const owner = await MooChar.findOne({ userId: home.owner }).sort({ active: -1 });
    if (!owner) { await MooRoom.updateOne({ roomId: h.roomId }, { $set: { 'props.home.rentDue': now + 7 * 86400000 } }); continue; }
    const coin = (owner.attrs && owner.attrs.coin) || 0;
    const listing = require('./housing').listingByKey(home.listing) || { landlord: 'the landlord', name: 'your place' };
    if (coin >= home.rent) {
      await MooChar.updateOne({ _id: owner._id }, { $inc: { 'attrs.coin': -home.rent }, $set: { 'attrs.life.rentBehind': 0 } });
      await MooRoom.updateOne({ roomId: h.roomId }, { $set: { 'props.home.rentDue': now + 7 * 86400000 } });
      await tell(owner.userId, `Rent day. $${home.rent} to ${listing.landlord} for ${listing.name}. Paid, and nothing said.`, 'system', 'coin');
    } else {
      const behind = ((owner.attrs.life || {}).rentBehind || 0) + 1;
      await MooChar.updateOne({ _id: owner._id }, { $set: { 'attrs.life.rentBehind': behind } });
      await MooRoom.updateOne({ roomId: h.roomId }, { $set: { 'props.home.rentDue': now + 3 * 86400000 } });
      await tell(owner.userId, behind === 1 ? `Rent day, and you are ${home.rent - coin} short. ${listing.landlord} says nothing, which is worse. Three days.` : `${listing.landlord} stops by about the rent. ${behind} weeks behind. "I am not going to put you out. I am going to keep asking."`, 'system', 'knock');
      if (behind >= 2) await MooRumor.create({ text: `${owner.name} is behind on the rent at ${listing.name}`, about: [owner.userId], ward: h.district, kind: 'money', heat: 2 });
    }
  }
}

async function children(now) {
  const kids = await MooChar.find({ userId: /^kid:/ }).lean();
  if (!kids.length) return;
  const family = require('./family');
  const c = worldClock();
  for (const k of kids) {
    const ch = k.attrs.child || {};
    const stage = family.stageOf(ch);
    const set = {};
    /* stage change announcement */
    if (ch.stage && ch.stage !== stage.key) {
      for (const p of ch.parents || []) await tell(p, `${k.name.split(' ')[0]} is ${stage.label} now. ${stage.key === 'grown' ? '"claim ' + k.name.split(' ')[0] + '" if you want to play them.' : 'Where does the time go.'}`, 'system', 'levelup');
    }
    if (ch.stage !== stage.key) set['attrs.child.doing'] = pick(stage.doing);
    set['attrs.child.stage'] = stage.key;
    /* school: kids and teens, weekdays 8–15, at Treehouse Row */
    const homeId = (await MooChar.findOne({ userId: (ch.parents || [])[0] }).select('attrs.life.home').lean() || {}).attrs;
    const home = homeId && homeId.life && homeId.life.home;
    const schoolTime = !c.weekend && c.h >= 8 && c.h < 15 && (stage.key === 'kid' || stage.key === 'teen');
    if (!k.attrs.followUser) {
      if (schoolTime && k.roomId !== 'treehouse_row') { set.roomId = 'treehouse_row'; set['attrs.child.doing'] = 'at school, allegedly'; await emit(k.roomId, k.userId, k.name, 'leave', `${k.name.split(' ')[0]} heads off to school.`); await emit('treehouse_row', k.userId, k.name, 'enter', `${k.name.split(' ')[0]} arrives for school.`); }
      else if (!schoolTime && home && k.roomId !== home && k.roomId === 'treehouse_row') { set.roomId = home; set['attrs.child.doing'] = pick(stage.doing); await emit('treehouse_row', k.userId, k.name, 'leave', `${k.name.split(' ')[0]} heads home.`); await emit(home, k.userId, k.name, 'enter', `${k.name.split(' ')[0]} is home from school.`); }
      else if (Math.random() < 0.2) set['attrs.child.doing'] = pick(stage.doing);
    }
    /* hunger and happiness on the calendar */
    const hungryDays = daysBetween(ch.fedAt || now, now);
    if (hungryDays >= 1 && ch.happy > 20) set['attrs.child.happy'] = Math.max(20, (ch.happy || 50) - 5);
    if (hungryDays >= 2 && (!ch.reedAt || now - ch.reedAt > 86400000)) {
      set['attrs.child.reedAt'] = now;
      for (const p of ch.parents || []) await tell(p, `Miss Reed stops by. "${k.name.split(' ')[0]} has not eaten in two days. I am not here to take anybody. I am here to say I noticed." Feed them.`, 'system', 'knock');
      await MooRumor.create({ text: `Miss Reed was seen at ${(ch.parents || []).length ? 'the ' + k.name.split(' ').slice(1).join(' ') + ' place' : 'somebody’s door'}`, about: ch.parents || [], ward: 'patch', kind: 'family', heat: 3 });
    }
    if (Object.keys(set).length) await MooChar.updateOne({ _id: k._id }, { $set: set });
  }
}

async function marks(now) {
  const souls = await MooChar.find({ 'attrs.markMeta': { $exists: true } }).select('attrs.marks attrs.markMeta userId').lean();
  for (const s of souls) {
    const meta = s.attrs.markMeta || {};
    const expired = Object.entries(meta).filter(([, until]) => until && until < now).map(([m]) => m);
    if (!expired.length) continue;
    const keep = (s.attrs.marks || []).filter((m) => !expired.includes(m));
    const newMeta = Object.fromEntries(Object.entries(meta).filter(([m]) => !expired.includes(m)));
    await MooChar.updateOne({ _id: s._id }, { $set: { 'attrs.marks': keep, 'attrs.markMeta': newMeta } });
    if (!s.userId.startsWith('npc:')) await tell(s.userId, `${expired.join(' and ')} — faded. The city forgets faster than it lets on.`, 'system');
  }
  /* habit fades after three clean days */
  const habits = await MooChar.find({ 'attrs.marks': 'a habit', 'attrs.life.viceAt': { $lt: now - 3 * 86400000 } }).lean();
  for (const h of habits) await MooChar.updateOne({ _id: h._id }, { $pull: { 'attrs.marks': 'a habit' }, $set: { 'attrs.life.vice': 0 } });
}

let lastRumorDecayDay = null;
async function rumors(now) {
  await MooRumor.deleteMany({ at: { $lt: new Date(now - 14 * 86400000) } });
  const day = worldClock().dayKey;
  if (lastRumorDecayDay === day) return;
  lastRumorDecayDay = day;
  await MooRumor.updateMany({ at: { $lt: new Date(now - 2 * 86400000) }, heat: { $gt: 1 } }, { $inc: { heat: -1 } });
}

module.exports = { run };
