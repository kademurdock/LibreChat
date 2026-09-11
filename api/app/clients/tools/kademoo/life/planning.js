const { RESIDENT_PILOT, runResidentPilot, activeResidentAction } = require('@librechat/api');
const { MooChar, MooRoom, MooDistrict, MooEvent, nextSeq } = require('~/models/kadeMoo');
const { logger } = require('@librechat/data-schemas');
const reverie = require('../reverie');
const { register } = require('./registry');

let pending = null;

/* THE STANDING ALLOWANCE (Part 180.2, Sep 11 2026, her word: "Fifty cents a
 * day is fine for the resident things; if glm isn't much differently priced
 * it's fine to leave it how it is"). The twelve-call trial above stays
 * exactly as it was (its harness proves the ceiling); beside it, a DAILY
 * allowance lets the same planner keep choosing small activities for the
 * citizens, on the same model, with the same five-minute spacing. Default
 * OFF in code: REVERIE_RESIDENT_DAILY_USD on the service is the only knob
 * (0.50 set at her word), so a test tree spends nothing and the live number
 * is visible on Railway. Half a cent is reserved a call — a planner call is
 * about 1,500 tokens on glm-5.3-flash, well under that — so fifty cents is
 * at most a hundred calls a day, and the five-minute interval bounds it to
 * 288 anyway. A new day starts on the world clock (Central). */
const DAILY_ID = 'reverie_resident_daily_180';
const DAILY_RESERVE_USD = 0.005;
function dailyCapUSD() {
  const n = Number(process.env.REVERIE_RESIDENT_DAILY_USD || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
async function reserveDaily(now) {
  const cap = dailyCapUSD();
  if (!cap) return false;
  const day = require('./ctx').worldClock().dayKey;
  await MooDistrict.updateOne(
    { districtId: DAILY_ID },
    { $setOnInsert: { name: 'Resident planning, daily allowance', props: { day, calls: 0, spentUSD: 0, nextAt: 0, reservePerCallUSD: DAILY_RESERVE_USD } } },
    { upsert: true },
  );
  await MooDistrict.updateOne(
    { districtId: DAILY_ID, 'props.day': { $ne: day } },
    { $set: { 'props.day': day, 'props.calls': 0, 'props.spentUSD': 0 } },
  );
  const result = await MooDistrict.updateOne(
    { districtId: DAILY_ID, 'props.day': day, 'props.spentUSD': { $lte: cap - DAILY_RESERVE_USD + 1e-9 }, 'props.nextAt': { $lte: now } },
    { $inc: { 'props.calls': 1, 'props.spentUSD': DAILY_RESERVE_USD }, $set: { 'props.nextAt': now + RESIDENT_PILOT.intervalMs } },
  );
  return result.modifiedCount === 1;
}

function publicActivity(person, schedule, outdoor = false) {
  return activeResidentAction(person.attrs?.residentPlan, person.roomId, schedule, outdoor)?.action
    .doing;
}

function tickResidents(rooms, weather) {
  if (pending || !rooms.length) return;
  pending = runResidentPilot(
    {
      async residents() {
        const visitors = await MooChar.find({
          userId: { $not: /^(npc|kid|stray|pet):/ },
          active: true,
          'attrs.life.created': true,
          lastActiveAt: { $gte: new Date(Date.now() - 15 * 60_000) },
          roomId: { $in: rooms },
        })
          .select('roomId')
          .lean();
        const occupied = [...new Set(visitors.map((visitor) => visitor.roomId))];
        const [people, places] = await Promise.all([
          MooChar.find({ userId: /^npc:/, active: true, roomId: { $in: occupied } })
            .select('userId name roomId attrs.residentPlan')
            .lean(),
          MooRoom.find({ roomId: { $in: occupied }, 'props.home': { $exists: false } })
            .select('roomId name props.outdoor props.hangout')
            .lean(),
        ]);
        const byRoom = new Map(places.map((place) => [place.roomId, place]));
        return people.flatMap((person) => {
          const room = byRoom.get(person.roomId),
            canon = reverie.CENSUS_BY_ID[person.userId];
          const slot = reverie.npcDoingNow(person.userId);
          if (!room || !canon || slot?.room !== room.roomId) return [];
          return [
            {
              id: person.userId,
              name: person.name,
              roomId: room.roomId,
              roomName: room.name,
              outdoor: !!room.props.outdoor,
              schedule: slot.doing,
              character: canon.desc || '',
              gathering: !!room.props.hangout,
              plan: person.attrs?.residentPlan,
            },
          ];
        });
      },
      async reserve(now) {
        const result = await MooDistrict.updateOne(
          {
            districtId: RESIDENT_PILOT.id,
            'props.enabledUntil': { $gt: now },
            'props.calls': { $lt: RESIDENT_PILOT.limit },
            'props.nextAt': { $lte: now },
          },
          {
            $inc: { 'props.calls': 1 },
            $set: { 'props.nextAt': now + RESIDENT_PILOT.intervalMs },
          },
        );
        if (result.modifiedCount === 1) return true;
        /* the trial is spent or paused: the standing daily allowance, if any */
        return reserveDaily(now);
      },
      async apply(resident, plan) {
        const slot = reverie.npcDoingNow(resident.id);
        if (slot?.room !== resident.roomId || slot.doing !== resident.schedule) return false;
        if (
          !(await MooRoom.exists({
            roomId: resident.roomId,
            'props.home': { $exists: false },
            'props.hangout': null,
          }))
        )
          return false;
        const result = await MooChar.updateOne(
          {
            userId: resident.id,
            active: true,
            roomId: resident.roomId,
            'attrs.residentPlan.startedAt': resident.plan?.startedAt ?? null,
          },
          { $set: { 'attrs.residentPlan': plan } },
        );
        return result.modifiedCount === 1;
      },
      async emit(resident, action, step) {
        if (!(await MooRoom.exists({ roomId: resident.roomId, 'props.hangout': null })))
          return false;
        const result = await MooChar.updateOne(
          {
            userId: resident.id,
            active: true,
            roomId: resident.roomId,
            'attrs.residentPlan.startedAt': resident.plan.startedAt,
            'attrs.residentPlan.emitted': { $lt: step },
          },
          { $set: { 'attrs.residentPlan.emitted': step } },
        );
        if (!result.modifiedCount) return false;
        await MooEvent.create({
          seq: await nextSeq(),
          roomId: resident.roomId,
          actorUserId: resident.id,
          actorName: resident.name,
          kind: 'emote',
          text: `${resident.name} ${action.event}`,
          sound: action.sound || null,
        });
        return true;
      },
    },
    weather,
  )
    .catch(() => logger.warn('[reverie] resident pilot unavailable; ordinary schedules continue'))
    .finally(() => {
      pending = null;
    });
}

register({
  name: '@resident pilot',
  hidden: true,
  free: true,
  async run(ctx, { arg }) {
    if (!ctx.isWizard) return ctx.fail('That control belongs to the Founder.');
    if (arg === 'start') {
      await MooDistrict.updateOne(
        { districtId: RESIDENT_PILOT.id },
        {
          $setOnInsert: {
            name: 'Resident planning trial',
            props: {
              calls: 0,
              nextAt: 0,
              enabledUntil: Date.now() + 4 * 60 * 60_000,
              reservePerCallUSD: RESIDENT_PILOT.reserveUSD,
              limit: RESIDENT_PILOT.limit,
            },
          },
        },
        { upsert: true },
      );
    } else if (arg === 'pause') {
      await MooDistrict.updateOne(
        { districtId: RESIDENT_PILOT.id },
        { $set: { 'props.enabledUntil': 0 } },
      );
    } else if (arg && arg !== 'status')
      return ctx.fail('Use @resident pilot start, status, or pause.');
    const record = await MooDistrict.findOne({ districtId: RESIDENT_PILOT.id }).lean();
    const calls = record?.props?.calls || 0;
    const active = record?.props?.enabledUntil > Date.now() && calls < RESIDENT_PILOT.limit;
    const plans = await MooChar.find({
      userId: /^npc:/,
      'attrs.residentPlan.startedAt': { $exists: true },
    })
      .select('attrs.residentPlan.emitted')
      .lean();
    const emitted = plans.filter((person) => person.attrs?.residentPlan?.emitted >= 0).length;
    return ctx.ok({
      lines: [
        `Resident trial: ${active ? 'active' : 'paused or finished'}. ${calls} of ${RESIDENT_PILOT.limit} requests reserved, at most $0.36 total. Starting again never refills or extends it. Ordinary routines continue.`,
        `${plans.length} residents have a latest saved plan; ${emitted} of those plans show an emitted activity step. These are saved-plan snapshots, not a lifetime activity count or a billed-cost receipt.`,
        record?.props?.enabledUntil > 0
          ? `The planning window ends at ${new Date(record.props.enabledUntil).toISOString()}.`
          : 'No planning window is currently enabled.',
        await dailyLine(),
      ],
    });
  },
});

async function dailyLine() {
  const cap = dailyCapUSD();
  if (!cap) return 'Standing daily allowance: off (REVERIE_RESIDENT_DAILY_USD is not set).';
  const d = await MooDistrict.findOne({ districtId: DAILY_ID }).lean();
  const p = (d && d.props) || {};
  return `Standing daily allowance: $${cap.toFixed(2)} a day, half a cent reserved a call. Today (${p.day || 'no day yet'}): ${p.calls || 0} call${p.calls === 1 ? '' : 's'}, $${Number(p.spentUSD || 0).toFixed(3)} reserved.`;
}

module.exports = { tickResidents, publicActivity, settled: () => pending, dailyCapUSD, DAILY_ID, DAILY_RESERVE_USD };
