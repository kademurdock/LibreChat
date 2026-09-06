/* REVERIE LIFE — the entry point (Sep 6 2026).
 *
 * One call: runCommand({ userId, displayName, command, isWizard, live }).
 * Same signature as the old engine's, same result shape plus more, so every
 * existing client (the web page, the native World screen) keeps working and
 * a new client gets the whole picture:
 *
 *   {
 *     ok, lines, room, kinds, sounds, district,        // as before
 *     hud:     { name, coin, clock, weather, needs… }, // the meters
 *     actions: [ { label, cmd, group } ],              // what you can do HERE
 *     people:  [ { name, kind, tag, cmds } ],          // who is here, tappable
 *     exits:   [ { dir, label, to } ],                 // the compass
 *     choices: [ { label, cmd } ],                     // a menu, when in one
 *     mode:    'play' | 'create' | 'menu',
 *   }
 *
 * The turn: load the soul → tick the world → catch up the meanwhile → decay
 * the needs → (wizard, if the soul is still being born) → roundtime →
 * resolve the verb here → else hand the words to the old engine → apply the
 * after-effects → decorate. Zero model calls. */
const registry = require('./registry');
const ctxlib = require('./ctx');
const needs = require('./needs');
const skills = require('./skills');
const { MooChar, logger } = ctxlib;

const oldEngine = require('../engine');
const reverie = require('../reverie');

/* verb packs — each registers itself on require */
require('./verbs_basics');
require('./creation');
require('./housing');
require('./shops');
require('./relationships');
require('./family');
require('./vehicles');
require('./activities');
require('./drama');
require('./help');
const view = require('./view');
const lifeTick = require('./tick');

const FREE_VERBS = new Set(['look', 'l', 'recap', 'status', 'me', 'time', 'weather', 'exits', 'where', 'who', 'inventory', 'inv', 'i', 'coins', 'money', 'help', 'chars', 'map', 'dir', 'watch', 'wait', 'listen', 'skills', 'needs', 'home?', 'hint', 'rumors', 'gossip', 'relationships', 'family', 'scores', 'menu', 'shop', 'browse', 'recipes', 'careers', 'listings', 'wallet', 'what']);

function lifeOf(ch) {
  if (!ch.attrs) ch.attrs = {};
  if (!ch.attrs.life) ch.attrs.life = {};
  return ch.attrs.life;
}

async function runCommand({ userId, displayName, command, isWizard = false, live = false }) {
  const ch = await oldEngine.getOrCreateChar(userId, displayName);
  // City activity belongs to the live room, not the reply to this command.
  await reverie.tickWorld();
  try { await lifeTick.run(); } catch (e) { logger.error('[life] tick failed (non-fatal):', e && e.message); }
  const { result, events } = await oldEngine.withCommandEvents(() => runTurn({ ch, userId, command, isWizard, live }));
  if (events.length) {
    await MooChar.updateOne({ userId: String(userId), active: true }, { $push: { 'attrs.seenEventSeqs': { $each: events, $slice: -100 } } });
    result.seenSeqs = events;
  }
  return result;
}

async function runTurn({ ch, userId, command, isWizard, live }) {
  const life = lifeOf(ch);
  const lines = [];
  let kinds = [];
  const sounds = [];

  /* MEANWHILE — unless a live stream is already carrying it to this client. */
  if (!live) {
    const meanwhile = await oldEngine.collectMeanwhile(ch);
    kinds = meanwhile.map((m) => m.sound || m.kind);
    if (meanwhile.length) {
      const recapText = meanwhile.map((m) => m.text).join(' | ').slice(0, 1500);
      lines.push('MEANWHILE (since your last turn): ' + recapText);
      await ctxlib.setAttrs(ch, { lastMeanwhile: recapText });
    }
    var meanwhileItems = meanwhile; /* structured copy for the new client; the joined line stays for native */
  } else {
    await MooChar.updateOne({ _id: ch._id }, { $set: { lastActiveAt: new Date() } });
  }

  /* NEEDS — decay only for time actually played (Law 3 in the math). */
  const now = Date.now();
  const dec = needs.decayed(life, now);
  if (dec.changed) {
    life.needs = dec.needs;
    life.needsAt = now;
    await ctxlib.setAttrs(ch, { 'life.needs': dec.needs, 'life.needsAt': now });
  }

  const cmd = String(command || '').trim().replace(/\s+/g, ' ');
  const lower = cmd.toLowerCase();

  const ctx = {
    ch, userId: ch.userId, isWizard, live,
    cmd, lower, lines, kinds, sounds,
    life,
    _room: null,
    async room() { if (!this._room) this._room = await ctxlib.roomOf(this.ch); return this._room; },
    say(...ls) { for (const l of ls) if (l) lines.push(l); return this; },
    kind(k) { if (k) kinds.push(k); return this; },
    sound(s) { if (s) sounds.push(s); return this; },
    ok(extra = {}) { return { ok: true, lines, kinds, sounds, ...extra }; },
    fail(line, extra = {}) { if (line) lines.push(line); return { ok: false, lines, kinds, sounds, ...extra }; },
    /** need deltas and skill gains queued by verbs, applied after the verb */
    fx: { needs: {}, skill: null },
    need(delta) { for (const [k, v] of Object.entries(delta)) this.fx.needs[k] = (this.fx.needs[k] || 0) + v; return this; },
    learn(skill, base) { this.fx.skill = { skill, base }; return this; },
    ...ctxlib,
  };

  let result;
  try {
    /* THE WIZARD — a soul still being born answers questions, not verbs. */
    const creation = require('./creation');
    if (!life.created || life.wiz) {
      result = await creation.handle(ctx);
    } else {
      result = await dispatch(ctx);
    }
  } catch (e) {
    logger.error('[life] command failed:', e && (e.stack || e.message));
    result = { ok: false, lines: [...lines, 'The world flickered before it could confirm that command. Check look or status before repeating a purchase or another action.'], kinds };
  }

  // Older verbs and character switching write through their own document.
  const current = await MooChar.findOne({ userId: String(userId), active: true });
  if (current) { ctx.ch = current; ctx.life = lifeOf(current); ctx._room = null; }

  /* AFTER-EFFECTS — needs and skills queued by the verb, or implied by kind. */
  try { await applyEffects(ctx, result); } catch (e) { logger.error('[life] effects failed:', e && e.message); }

  /* DECORATE — the HUD, the buttons, the people, the compass. */
  if (typeof meanwhileItems !== 'undefined' && meanwhileItems.length) result.meanwhile = meanwhileItems;
  try { result = await view.decorate(ctx, result); } catch (e) { logger.error('[life] decorate failed:', e && e.message); }
  return result;
}

async function dispatch(ctx) {
  const { cmd, lower, ch } = ctx;
  if (!lower) return registry.get('look').run(ctx, { arg: '', argRaw: '' });

  const firstWord = lower.split(' ')[0];
  let hit = registry.resolve(cmd);
  if (!hit && !firstWord.startsWith('@')) {
    const done = registry.complete(firstWord);
    if (done) hit = registry.resolve(done + cmd.slice(firstWord.length));
  }

  /* ROUNDTIME — hands and feet wait, senses do not. */
  const busyUntil = (ch.attrs && ch.attrs.busyUntil) || 0;
  const verbName = hit ? hit.verb.name : firstWord;
  const isFree = (hit && hit.verb.free) || FREE_VERBS.has(verbName) || firstWord.startsWith('@');
  if (busyUntil > Date.now() && !isFree) {
    const secs = Math.ceil((busyUntil - Date.now()) / 1000);
    return ctx.fail(`You are mid-${(ch.attrs && ch.attrs.busyDoing) || 'something'} — about ${secs} second${secs === 1 ? '' : 's'} left. Senses are free: look, status, who.`);
  }

  if (hit) {
    if (hit.verb.when && !(await hit.verb.when(ctx))) {
      if (!hit.verb.fallthrough) {
        const why = hit.verb.whyNot ? await hit.verb.whyNot(ctx) : null;
        return ctx.fail(why || `Not here, not now. (${hit.verb.help && hit.verb.help.usage ? hit.verb.help.usage : hit.verb.name})`);
      }
      hit = null; /* the old engine owns this word when ours does not apply */
    } else {
      ctx.verbName = hit.verb.name;
      return hit.verb.run(ctx, hit);
    }
  }

  /* THE OLD ENGINE still knows a hundred verbs. Let it try. */
  const old = await oldEngine.runCommand({ userId: ch.userId, displayName: ch.name, command: cmd, isWizard: ctx.isWizard, live: true });
  if (old && !old.unknown) {
    /* merge: our meanwhile lines first, then theirs (minus a duplicate MEANWHILE) */
    const theirs = (old.lines || []).filter((l) => !/^MEANWHILE/.test(l));
    ctx.fromOld = true;
    ctx.oldKinds = (old.kinds || []).filter((k) => k !== 'look');
    return { ...old, lines: [...ctx.lines, ...theirs], kinds: [...ctx.kinds, ...(old.kinds || [])], sounds: [...ctx.sounds, ...(old.sounds || [])] };
  }

  const sug = registry.suggest(firstWord);
  return ctx.fail(sug.length
    ? `The world does not know "${cmd}". Did you mean: ${sug.join(', ')}? (help lists everything.)`
    : `The world does not know "${cmd}". Try "help", or "what" to hear what you can do right here.`);
}

/** Needs and skills settle after the verb. Implied effects come from what
 *  the old engine reported (its kinds) so its hundred verbs feed the meters too. */
async function applyEffects(ctx, result) {
  if (!result || !result.ok) return;
  const { ch, life } = ctx;
  const delta = { ...ctx.fx.needs };
  if (ctx.fromOld && result && result.ok) {
    const l = ctx.lower;
    const first = l.split(' ')[0];
    if (/^(say|speak|whisper|talk|emote|page)\b/.test(l)) delta.company = (delta.company || 0) + 3;
    if (/^(cast|land|reel|forage|plant|water|pick|weed|flatten|wish|pray|petition|approach|pet|coax|offer|carry|adopt)\b/.test(l)) delta.fun = (delta.fun || 0) + 2;
    if (first === 'land') ctx.fx.skill = ctx.fx.skill || { skill: 'fishing', base: 6 };
    if (/^(plant|water|weed|pick|forage)\b/.test(l)) ctx.fx.skill = ctx.fx.skill || { skill: 'garden', base: 2 };
    if (/^(pet|coax|approach|offer)\b/.test(l)) ctx.fx.skill = ctx.fx.skill || { skill: 'care', base: 1 };
    const social = require('../social');
    if (social.SOCIALS[first]) delta.fun = (delta.fun || 0) + 1;
  }
  const patch = {};
  if (Object.keys(delta).length) {
    life.needs = needs.apply(life.needs || needs.fresh(), delta);
    patch['life.needs'] = life.needs;
  }
  if (ctx.fx.skill && ctx.fx.skill.skill in skills.SKILLS) {
    const mood = needs.moodOf(life.needs || needs.fresh());
    const g = skills.gain(life.skills || {}, ctx.fx.skill.skill, ctx.fx.skill.base, mood.mult);
    life.skills = { ...(life.skills || {}), [ctx.fx.skill.skill]: g.xp };
    patch['life.skills'] = life.skills;
    if (g.leveled) {
      const title = skills.titleOf(ctx.fx.skill.skill, g.xp);
      result.lines = result.lines || [];
      result.lines.push(`Your ${skills.SKILLS[ctx.fx.skill.skill].name} is now level ${g.level}: ${title}.`);
      result.kinds = [...(result.kinds || []), 'levelup'];
      const pr = require('../social').pronounsOf(ch);
      await ctxlib.emit(ch.roomId, ch.userId, ch.name, 'emote', `${ch.name} looks quietly pleased with ${pr.self || 'themselves'}. (${skills.SKILLS[ctx.fx.skill.skill].name} ${g.level})`);
    }
  }
  if (Object.keys(patch).length) await ctxlib.setAttrs(ch, patch);
}

module.exports = { runCommand, registry };
