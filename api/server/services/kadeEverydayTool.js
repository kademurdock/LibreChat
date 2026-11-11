'use strict';
/**
 * KADE EVERYDAY, the words the model sees (Nov 11 2026, home agent plan cards 6 and 7).
 *
 * kade_notify keeps its old description and schema byte for byte while KADE_REMIND_ALL=0. With it
 * on (the default) the tool gains reminders that come back as a message in the chat plus a push,
 * and check-backs; with KADE_EVERYDAY on as well (the default) it gains timers, alarms, the time
 * where the person lives, a daily medicine schedule, running lists and saved phone numbers.
 *
 * Characters run on a cheap model, so every line here is short and plain. The production path
 * binds packages/api/src/tools/registry/definitions.ts, not this file: that copy is kept identical
 * by hand, and kadeEveryday.nodetest.js checks that every string below appears there. Keep the
 * strings free of quote marks and apostrophes so that check stays a plain text search.
 *
 * No '~' requires, so node --test loads it.
 */

const LEGACY_ACTIONS = [
  'send',
  'schedule_checkin',
  'list_checkins',
  'pause_checkin',
  'cancel_checkin',
  'test_checkin',
  'set_reminder',
  'list_reminders',
  'cancel_reminder',
  'platform_status',
  'broadcast_whats_new',
  'spontaneous_on',
  'spontaneous_off',
];

/* Card 6: reminders for every character, delivered by the site. */
const REMIND_ACTIONS = ['check_back', 'reminder_wording', 'reminders_on'];

/* Card 7: everyday helpers that need no connection. */
const EVERYDAY_ACTIONS = [
  'timer',
  'alarm',
  'now',
  'set_timezone',
  'medicine_add',
  'medicine_list',
  'medicine_change',
  'list_add',
  'list_remove',
  'list_read',
  'list_clear',
  'contact_save',
  'contact_read',
  'contact_remove',
];

function remindOn(env = process.env) {
  return String((env && env.KADE_REMIND_ALL) ?? '') !== '0';
}

/** Card 7 rides on card 6: its timers and medicine times are delivered the same way. */
function everydayOn(env = process.env) {
  return remindOn(env) && String((env && env.KADE_EVERYDAY) ?? '') !== '0';
}

const DESCRIPTION_REMIND =
  'Reminders for the person you are talking with. A reminder comes back to them later as a message from you in this chat, plus a phone notification that says only that you have a reminder for them. ' +
  'Call the tool FIRST. Say a reminder is set only after the tool answers with Reminder set. If it answers FAILED, tell them plainly that it is not set. ' +
  'Only set what they asked for. Times are in their own time zone. ' +
  'Other actions: send pings their phone right now. The check-in actions set a repeating message from you. platform_status is a real health check. spontaneous_on and spontaneous_off switch whether you may text them first.';

const DESCRIPTION_EVERYDAY =
  ' Everyday helpers too: timers, alarms, the date and time where they live, daily medicine times, running lists such as to-do and shopping, and phone numbers they ask you to keep.';

const ACTION_NOTE_BASE =
  'What to do. set_reminder: one reminder (body, plus in_minutes or fire_date and fire_time; label for paperwork deadlines, ride booking and the like). ' +
  'check_back: ask them later whether something got done (body is the question). ' +
  'list_reminders. cancel_reminder (schedule_id). ' +
  'reminder_wording: short (the lock screen names nothing) or full. ' +
  'reminders_on: only after they ask to have reminders back. ' +
  'send: ping their phone now. schedule_checkin, list_checkins, pause_checkin, cancel_checkin, test_checkin: a repeating check-in. platform_status. broadcast_whats_new is owner only. spontaneous_on, spontaneous_off.';

const ACTION_NOTE_EVERYDAY =
  ' timer: in_minutes. alarm: fire_time. now: the date and time where they live. set_timezone. ' +
  'medicine_add (name, times, days), medicine_list, medicine_change (name and change). ' +
  'list_add and list_remove (list and item), list_read (list; leave out for all list names), list_clear (asks first; call again only after their own yes). ' +
  'contact_save (name and number), contact_read (name), contact_remove (name).';

/* Field schemas. Everything a person says about a time is in THEIR time zone. */
const FIELDS_REMIND = {
  body: {
    type: 'string',
    description: 'The reminder words, the check-back question, or the text for send. Short and plain.',
  },
  title: { type: 'string', description: 'Optional short title for send. Defaults to your name.' },
  urgent: {
    type: 'boolean',
    description: 'send only. True only for something truly time critical: it rings through quiet hours (9pm to 8am Central).',
  },
  in_minutes: { type: 'number', description: 'set_reminder, check_back or timer: how many minutes from now.' },
  fire_date: {
    type: 'string',
    description: 'set_reminder, check_back or alarm: the date as YYYY-MM-DD in their own time. Work it out from today.',
  },
  fire_time: {
    type: 'string',
    description: 'set_reminder, check_back or alarm: the time as HH:mm, 24-hour, in their own time.',
  },
  label: {
    type: 'string',
    description: 'set_reminder, optional: what kind of reminder, for example benefits paperwork, ride booking, appointment.',
  },
  follows: { type: 'string', description: 'check_back, optional: the id of the reminder it follows up.' },
  wording: { type: 'string', enum: ['short', 'full'], description: 'reminder_wording: short or full.' },
  time: { type: 'string', description: 'schedule_checkin: the daily time, 24-hour Central HH:mm, daytime only.' },
  days: {
    type: 'string',
    description: 'schedule_checkin or medicine_add: daily, or day names such as mon,wed,fri.',
  },
  topic: { type: 'string', description: 'schedule_checkin, optional: what to bring up.' },
  schedule_id: {
    type: 'string',
    description: 'cancel_reminder and the check-in actions: the id from the list.',
  },
};

const FIELDS_EVERYDAY = {
  name: {
    type: 'string',
    description: 'medicine actions: the medicine. contact actions: who, for example my sister.',
  },
  times: {
    type: 'string',
    description: 'medicine_add: the times each day, 24-hour, comma separated, for example 08:00,20:00.',
  },
  change: {
    type: 'string',
    enum: ['pause', 'resume', 'skip_today', 'remove'],
    description: 'medicine_change: pause, resume, skip_today or remove.',
  },
  list: { type: 'string', description: 'list actions: the list name, for example shopping or to-do.' },
  item: {
    type: 'string',
    description: 'list_add or list_remove: the item. Several items may be separated by commas.',
  },
  number: { type: 'string', description: 'contact_save: the phone number, digits as they said them.' },
  timezone: {
    type: 'string',
    description: 'set_timezone: their time zone, for example Central, Pacific or America/Denver.',
  },
};

/**
 * The description and schema kade_notify carries under the current switches.
 * @param {{ legacyDescription: string, legacyForModel?: string, legacySchema: object }} legacy
 * @param {object} [env]
 * @returns {{ description: string, descriptionForModel: string, schema: object, mode: 'legacy'|'remind'|'everyday' }}
 */
function notifyDefinition(legacy, env = process.env) {
  if (!remindOn(env)) {
    return {
      description: legacy.legacyDescription,
      descriptionForModel: legacy.legacyForModel || legacy.legacyDescription,
      schema: legacy.legacySchema,
      mode: 'legacy',
    };
  }
  const full = everydayOn(env);
  const actions = [...LEGACY_ACTIONS, ...REMIND_ACTIONS, ...(full ? EVERYDAY_ACTIONS : [])];
  const description = DESCRIPTION_REMIND + (full ? DESCRIPTION_EVERYDAY : '');
  const schema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: actions, description: ACTION_NOTE_BASE + (full ? ACTION_NOTE_EVERYDAY : '') },
      ...FIELDS_REMIND,
      ...(full ? FIELDS_EVERYDAY : {}),
    },
    required: ['action'],
  };
  return { description, descriptionForModel: description, schema, mode: full ? 'everyday' : 'remind' };
}

/** Is this action handled by the site (services/kadeEveryday.js) under these switches? */
function ownsAction(action, env = process.env) {
  if (!remindOn(env)) return false;
  if (['set_reminder', 'list_reminders', 'cancel_reminder', ...REMIND_ACTIONS].includes(action)) return true;
  return everydayOn(env) && EVERYDAY_ACTIONS.includes(action);
}

module.exports = {
  LEGACY_ACTIONS,
  REMIND_ACTIONS,
  EVERYDAY_ACTIONS,
  DESCRIPTION_REMIND,
  DESCRIPTION_EVERYDAY,
  ACTION_NOTE_BASE,
  ACTION_NOTE_EVERYDAY,
  FIELDS_REMIND,
  FIELDS_EVERYDAY,
  remindOn,
  everydayOn,
  notifyDefinition,
  ownsAction,
};
