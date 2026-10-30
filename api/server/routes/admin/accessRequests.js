const express = require('express');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const crypto = require('node:crypto');
const { checkEmailConfig, deliverApprovalEmail, approvalEmailNotice } = require('@librechat/api');
const sendEmail = require('~/server/utils/sendEmail');
const {
  findEmail,
  looksLikeEmail,
  normalizePhone,
  prettyPhone,
  placeholderEmailForPhone,
  isPlaceholderEmail,
} = require('~/server/utils/kadeLoginId');
const bcrypt = require('bcryptjs');
const { findUser, updateUser, deleteAllUserSessions } = require('~/models');
const { registerUser } = require('~/server/services/AuthService');
const { KadeAccessRequest } = require('~/models/kadeAccessRequest');
const { getSight, getSights, setSight, parseSightChoice } = require('~/models/kadeSight');
const {
  placeWelcomeCall,
  checkWelcomeCall,
  welcomeCallOutcome,
  callResult,
  isSettled,
  describeOutcome,
  FINAL: FINAL_CALL_STATUSES,
} = require('~/server/utils/kadeWelcomeCall');

const router = express.Router();
router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN));

/**
 * Oct 29 2026: a welcome call placed in the last two days whose outcome is
 * not known yet gets asked about once more when Kade opens her page, so her
 * card can say "nobody answered" instead of leaving her to wonder. A handful
 * at most, each fail-soft; the page never waits on a broken bridge for long.
 */
async function refreshCallOutcomes(requests) {
  const since = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const due = requests
    .filter(
      (r) =>
        r.welcomeCallSid &&
        r.welcomeCallStatus === 'placed' &&
        !FINAL_CALL_STATUSES.includes(String(r.welcomeCallOutcome || '').split(':')[0]) &&
        r.welcomeCallAt &&
        new Date(r.welcomeCallAt).getTime() > since,
    )
    .slice(0, 5);
  await Promise.all(
    due.map(async (r) => {
      const outcome = await welcomeCallOutcome(r.welcomeCallSid);
      if (!outcome || !outcome.status) {
        return;
      }
      r.welcomeCallOutcome = [
        outcome.status,
        outcome.duration,
        outcome.answeredBy || '',
        outcome.played || '',
      ].join(':');
      /* 'voicemail', 'no-answer', 'answered'... -- the card stays in her
       * default view until it is 'answered' (isSettled). */
      r.welcomeCallResult = callResult(outcome);
      try {
        await KadeAccessRequest.findByIdAndUpdate(r._id, {
          $set: { welcomeCallOutcome: r.welcomeCallOutcome, welcomeCallResult: r.welcomeCallResult },
        });
      } catch (e) {
        logger.warn('[admin-access] could not save a call outcome:', e.message);
      }
    }),
  );
}

/** "completed:74:human:full" back into the sentence for her card. */
function outcomeSentence(stored) {
  if (!stored) {
    return '';
  }
  const [status, duration, answeredBy, played] = String(stored).split(':');
  return describeOutcome({
    status,
    duration: Number(duration || 0),
    answeredBy: answeredBy || null,
    played: played || null,
  });
}

/**
 * Oct 29 2026 (review): an approved card with an account shows the account's
 * CURRENT screen setting, not what they said at the door, so Kade sees the
 * truth and can change it there. One query for the whole list; fail-soft
 * (the page then says it could not read the setting).
 */
async function accountSights(requests) {
  const ids = requests
    .filter((r) => r.status === 'approved' && r.createdUserId)
    .map((r) => String(r.createdUserId));
  if (!ids.length) {
    return new Map();
  }
  try {
    return await getSights(ids);
  } catch (e) {
    logger.warn('[admin-access] could not read screen settings:', e.message);
    return null;
  }
}

router.get('/', async (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    const filter = status === 'all' ? {} : { status };
    const requests = await KadeAccessRequest.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    try {
      await refreshCallOutcomes(requests);
    } catch (e) {
      logger.warn('[admin-access] call outcome refresh skipped:', e.message);
    }
    const sights = await accountSights(requests);
    res.json({
      requests: requests.map((r) => ({
        id: String(r._id),
        name: r.name,
        contact: r.contact,
        whoYouAre: r.whoYouAre,
        whyHere: r.whyHere,
        status: r.status,
        audience: r.audience,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        /* Part 143: what the approval actually made, so the page can say so. */
        accountEmail: r.accountEmail || '',
        hasAccount: Boolean(r.createdUserId),
        emailStatus: r.emailStatus || '',
        emailRecipient: r.emailRecipient || '',
        /* Oct 29 2026: what they said about the screen, and the welcome call. */
        sight: r.sight === 'sighted' || r.sight === 'nonvisual' ? r.sight : null,
        usesPhoneLogin: isPlaceholderEmail(r.accountEmail),
        welcomeCallStatus: r.welcomeCallStatus || '',
        welcomeCallAt: r.welcomeCallAt || null,
        welcomeCallCount: r.welcomeCallCount || 0,
        welcomeCallNote: r.welcomeCallNote || '',
        welcomeCallOutcome: outcomeSentence(r.welcomeCallOutcome),
        welcomeCallResult: r.welcomeCallResult || '',
        /* true once a person heard the call for 20 s, or she said they are
         * already signed in; until then the card stays in her default view */
        welcomeCallSettled: isSettled(r),
        /* the account's own setting right now: 'sighted' | 'nonvisual' |
         * null (never set) | undefined (no account, or it could not be read) */
        accountSight:
          r.status === 'approved' && r.createdUserId && sights
            ? sights.get(String(r.createdUserId)) || null
            : undefined,
      })),
    });
  } catch (error) {
    logger.error('[admin-access] list failed', error);
    res.status(500).json({ error: 'Failed to list requests' });
  }
});

/* ── APPROVE MAKES THE ACCOUNT (Part 143, Sep 8 2026) ──────────────────────
 * Kade, after her sister Destiny knocked: "it gave me a welcome message that
 * told her to create an account with invite code 1336. I could have given her
 * that code without her messing with the door... The door needs to actually
 * create her an account if it doesn't already. When I say approve I mean
 * approve."
 *
 * The Aug-9 build ended at a copy-paste blessing carrying a registration
 * code, which made the doorbell a slower way to hand out a code the person
 * could have been given directly, and left the visitor with a form to fill
 * out and a code to type. Approving now MINTS THE ACCOUNT: a real user row,
 * email verified (her approval IS the verification), the adult/child tag
 * applied exactly the way the signup code applies it, and a spoken-friendly
 * temporary password in the message she sends. The code never appears again.
 *
 * WHAT THIS NEEDS AND WHY IT CANNOT ALWAYS HAVE IT: a LibreChat account is
 * keyed by EMAIL, and the door asks for "contact" as free text -- phone or
 * email, whatever the person had. So an email in the request (or one she
 * types on the web page) means the account gets made; no email means it
 * cannot be, and this still approves and says so plainly rather than
 * dead-ending. On the phone the native front desk shows readyMessage and
 * swallows everything else, so the message has to carry the whole truth.
 */
/** Readable, sayable, spellable out loud -- this gets read to people, often
 * by a screen reader and sometimes over the phone. No l/1/O/0 collisions. */
const PW_WORDS = [
  'amber',
  'anchor',
  'basket',
  'cedar',
  'cactus',
  'canyon',
  'cobalt',
  'copper',
  'dagger',
  'denim',
  'ember',
  'fable',
  'fennel',
  'garnet',
  'ginger',
  'harbor',
  'hazel',
  'indigo',
  'juniper',
  'kettle',
  'lantern',
  'maple',
  'marble',
  'meadow',
  'nutmeg',
  'otter',
  'pepper',
  'pewter',
  'quartz',
  'quilt',
  'ranger',
  'ribbon',
  'saddle',
  'sesame',
  'sparrow',
  'thistle',
  'timber',
  'tulip',
  'velvet',
  'walnut',
  'willow',
  'yarrow',
];
function tempPassword() {
  const pick = () => PW_WORDS[crypto.randomInt(0, PW_WORDS.length)];
  return `${pick()}-${pick()}-${pick()}-${crypto.randomInt(100, 1000)}`;
}

/** Exactly how registerUser stores a password, so a reset one is no different. */
function hashPassword(password) {
  const salt = bcrypt.genSaltSync(10);
  return bcrypt.hashSync(password, salt);
}

/**
 * Oct 29 2026: place the welcome call and put what happened on the request.
 * Never stores or logs the password. Always resolves.
 */
async function callAndRecord(requestId, { phone, name, password }) {
  const result = await placeWelcomeCall({ phone, name, password });
  const at = new Date();
  try {
    await KadeAccessRequest.findByIdAndUpdate(requestId, {
      $set: {
        welcomeCallStatus: result.status,
        welcomeCallSid: result.sid || '',
        welcomeCallAt: at,
        welcomeCallOutcome: '',
        welcomeCallResult: '',
        welcomeCallNote: String(result.reason || '').slice(0, 300),
      },
      $inc: { welcomeCallCount: 1 },
      ...(result.status === 'placed'
        ? { $push: { welcomeCallTimes: { $each: [at], $slice: -10 } } }
        : {}),
    });
  } catch (e) {
    logger.warn('[admin-access] could not record the welcome call:', e.message);
  }
  logger.info(
    `[admin-access] welcome call ${result.status} for request ${requestId} (...${String(phone).slice(-2)})`,
  );
  return result;
}

/** The sentence at the top of Kade's message about the call. */
function callLine(result, name, phone) {
  const where = prettyPhone(phone);
  if (result.status === 'placed') {
    return (
      `I'm calling ${name} now at ${where} to read their sign-in and password to them, slowly ` +
      'and twice. A voicemail only hears that we will call back, never the password. If they ' +
      'miss it, press "Call again" on their card on the Access Requests page, or read them the ' +
      'message below.'
    );
  }
  if (result.status === 'off') {
    return `Welcome calls are switched off, so read ${name} the password in the message below yourself.`;
  }
  return (
    `The call to ${name} at ${where} couldn't be placed (${result.reason}), so read them the ` +
    'password in the message below yourself, or press "Call again" on their card on the Access ' +
    'Requests page in a few minutes.'
  );
}

/**
 * Oct 29 2026: the answer to "Will you be looking at the screen, or
 * listening?" goes onto the account. `explicit` is what Kade picked on her
 * page (undefined when she left their own answer alone). A brand-new account
 * takes her pick or theirs. An account that already existed is only changed
 * when she picked explicitly, or when it has never been set at all.
 * Fail-soft: the account matters more than this flag.
 * @returns {Promise<'sighted'|'nonvisual'|null|undefined>} what the account now says, when known
 */
async function applySight(userId, { explicit, fromRequest, isNew }) {
  try {
    if (explicit !== undefined) {
      return (await setSight(userId, { sight: explicit }, 'admin')).sight;
    }
    if (!fromRequest) {
      return undefined;
    }
    if (!isNew && (await getSight(userId)).sight) {
      return undefined;
    }
    return (await setSight(userId, { sight: fromRequest }, 'signup')).sight;
  } catch (e) {
    logger.warn('[admin-access] could not set the screen flag (the account is fine):', e.message);
    return undefined;
  }
}

/**
 * The one place that decides what an approval will file the account under.
 * Part 143, second half (Kade: "make it accept a phone as login too. Not
 * everyone has both, one, or the other. It's not like we are texting or
 * emailing them."): an email if there is one, otherwise the phone number,
 * which becomes both the login and a placeholder address that can never
 * receive mail. Only a request with NEITHER cannot become an account.
 * @returns {{email:string|null, phone:string|null, placeholder:boolean}}
 */
function identityFor(doc, body) {
  const typedEmail = String(body?.email || '').trim();
  const typedPhone = String(body?.phone || '').trim();
  /* What she typed on the page wins; what they left at the door is the
   * fallback. A typed value that is neither is a mistake worth reporting, so
   * it does not quietly fall through to the contact line. */
  let email = null;
  let phone = null;
  if (typedEmail) {
    email = looksLikeEmail(typedEmail) ? typedEmail.toLowerCase() : null;
    if (!email) {
      return { email: null, phone: null, placeholder: false, badInput: typedEmail };
    }
  }
  if (typedPhone) {
    phone = normalizePhone(typedPhone);
  }
  if (!email) {
    email = findEmail(doc.contact);
  }
  if (!phone) {
    phone = normalizePhone(doc.contact);
  }
  if (email) {
    return { email, phone, placeholder: false };
  }
  if (phone) {
    return { email: placeholderEmailForPhone(phone), phone, placeholder: true };
  }
  return { email: null, phone: null, placeholder: false };
}

router.post('/:id/approve', async (req, res) => {
  try {
    const audience = req.body?.audience === 'child' ? 'child' : 'adult';
    const doc = await KadeAccessRequest.findById(req.params.id).lean();
    if (!doc) {
      return res.status(404).json({ error: 'Request not found' });
    }
    const domain = process.env.DOMAIN_CLIENT || 'https://kademurdock.com';
    const name = String(req.body?.name || doc.name || '').trim();
    const { email, phone, placeholder, badInput } = identityFor(doc, req.body);
    const note = String(req.body?.note || '').slice(0, 500);
    /* Oct 29 2026: Kade's own pick about the screen, only when she sent one.
     * Left out, the person's own answer at the door stands. */
    const explicitSight =
      req.body && Object.prototype.hasOwnProperty.call(req.body, 'sight')
        ? parseSightChoice(req.body.sight)
        : undefined;
    /** What they will type into the one login box. */
    const loginId = placeholder ? prettyPhone(phone) : email;

    const finish = async (extra, payload) => {
      await KadeAccessRequest.findByIdAndUpdate(req.params.id, {
        $set: {
          status: 'approved',
          audience,
          decidedAt: new Date(),
          decidedNote: note,
          ...(explicitSight !== undefined ? { sight: explicitSight } : {}),
          ...extra,
        },
      });
      if (payload.accountCreated || payload.alreadyHadAccount) {
        const recipient = extra.accountEmail;
        const emailStatus = await deliverApprovalEmail(recipient, {
          configured: checkEmailConfig(),
          claim: async () =>
            Boolean(
              await KadeAccessRequest.findOneAndUpdate(
                {
                  _id: doc._id,
                  emailStatus: { $nin: ['sending', 'accepted', 'unconfirmed'] },
                },
                {
                  $set: {
                    emailStatus: 'sending',
                    emailRecipient: recipient,
                    emailAttemptedAt: new Date(),
                  },
                },
              ),
            ),
          previousStatus: async () =>
            (await KadeAccessRequest.findById(doc._id).lean())?.emailStatus || 'unconfirmed',
          send: async () => {
            await sendEmail({
              email: recipient,
              subject: 'Your Kade-AI account is ready',
              template: 'accessApproved.handlebars',
              payload: {
                name,
                domain,
                loginId: payload.loginId || recipient,
                password: payload.accountCreated ? payload.tempPassword : '',
                resetEnabled: process.env.ALLOW_PASSWORD_RESET === 'true',
              },
            });
          },
          record: async (status) => {
            await KadeAccessRequest.findByIdAndUpdate(doc._id, { $set: { emailStatus: status } });
          },
        });
        payload.emailStatus = emailStatus;
        payload.emailNotice = approvalEmailNotice(emailStatus, recipient);
        payload.readyMessage = payload.emailNotice + '\n\n' + payload.readyMessage;
        logger.info(`[admin-access] account email ${emailStatus} for request ${doc._id}`);
      }
      /* Oct 29 2026: a phone-only account has nowhere to receive mail, so the
       * platform calls and reads the sign-in aloud. After the approval is
       * saved, so a slow phone line can never lose the account. */
      if (payload.welcomeCall) {
        const call = payload.welcomeCall;
        delete payload.welcomeCall;
        const result = await callAndRecord(doc._id, call);
        payload.welcomeCallStatus = result.status;
        payload.readyMessage = callLine(result, call.name, call.phone) + '\n\n' + payload.readyMessage;
      }
      return res.json({
        ok: true,
        id: String(doc._id),
        audience,
        contact: doc.contact,
        ...payload,
      });
    };

    /* A typed value that is not an email address at all: say so instead of
     * silently falling back to whatever the door collected. */
    if (badInput) {
      return res.status(400).json({
        error: `"${badInput}" is not an email address. Fix it, or clear the box and approve to use their phone number.`,
        needsEmail: true,
      });
    }

    /* Neither an email nor a phone number anywhere -- the only case left that
     * cannot become an account. Said in the message itself, because the phone
     * front desk shows the message and nothing else, and the code rides along
     * so she is never worse off than before any of this. */
    if (!email) {
      const code =
        audience === 'child' ? process.env.KADE_REG_CODE_CHILD : process.env.KADE_REG_CODE_ADULT;
      logger.warn(
        `[admin-access] approved "${doc.name}" but "${doc.contact}" holds no email and no phone -- no account made`,
      );
      return finish(
        {},
        {
          accountCreated: false,
          needsEmail: true,
          readyMessage:
            `I approved ${name}, but I could not make the account: their request left no email ` +
            `address and no phone number I could read (they gave "${doc.contact}"). Get either ` +
            `one from them, then open ${domain}/access-requests, type it in, and approve again ` +
            `-- that makes the account. If you would rather not wait, they can still sign up at ` +
            `${domain}/register with the code ${code}.`,
        },
      );
    }

    const existing =
      (await findUser({ email }, 'email _id name kadePhone')) ||
      (phone ? await findUser({ kadePhone: phone }, 'email _id name kadePhone') : null);
    if (existing) {
      logger.info(`[admin-access] "${doc.name}" already had an account (${email})`);
      const existingSight = await applySight(existing._id, {
        explicit: explicitSight,
        fromRequest: doc.sight,
        isNew: false,
      });
      return finish(
        { accountEmail: existing.email, createdUserId: String(existing._id) },
        {
          accountCreated: false,
          alreadyHadAccount: true,
          email: existing.email,
          ...(existingSight !== undefined ? { sight: existingSight } : {}),
          loginId: existing.kadePhone ? prettyPhone(existing.kadePhone) : existing.email,
          readyMessage:
            `Hey ${name} -- you already have an account here. Go to ${domain} and sign in with ` +
            `${existing.kadePhone ? prettyPhone(existing.kadePhone) : existing.email}. If the ` +
            `password is gone, tell me and I'll reset it for you.`,
        },
      );
    }

    /* The real registration path, exactly as the front door runs it -- same
     * validation, same balance setup, same child tagging -- so an approved
     * account is not a special second kind of account. */
    const password = tempPassword();
    const result = await registerUser(
      { name, email, password, confirm_password: password },
      phone
        ? { kadeAccountType: audience, kadePhone: phone, emailVerified: true }
        : { kadeAccountType: audience, emailVerified: true },
    );
    const made = await findUser({ email }, 'email _id');
    if (!made || result?.createdUserId !== String(made._id)) {
      logger.error(
        `[admin-access] account creation FAILED for "${doc.name}" (${email}): ${result?.message}`,
      );
      return res.status(500).json({
        error:
          `I could not make the account for ${name}: ${result?.message || 'registration refused it'}. ` +
          `The request is still waiting, so you can fix it and try again.`,
      });
    }
    /* Her approval IS the verification -- she knows who knocked. Without this
     * a mail-enabled deployment leaves them locked out behind an email they
     * may never see. */
    try {
      await updateUser(made._id, { emailVerified: true });
    } catch (e) {
      logger.warn('[admin-access] emailVerified flip failed (the account exists):', e.message);
    }

    /* Same courtesy the ordinary signup does: hand the phone to the bridge so
     * the voice line knows them. Fail-soft, always. */
    if (phone) {
      const bridgeSignupUrl =
        process.env.BRIDGE_SIGNUP_URL || 'https://kade-ai-bridge-production.up.railway.app/signup';
      fetch(bridgeSignupUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({
          name,
          phone,
          accountType: audience === 'child' ? 'child' : undefined,
        }),
      }).catch(() => {});
    }

    const madeSight = await applySight(made._id, {
      explicit: explicitSight,
      fromRequest: doc.sight,
      isNew: true,
    });

    logger.info(
      `[admin-access] ACCOUNT MADE for "${doc.name}" (signs in with ${loginId}${placeholder ? ', phone-only' : ''}) as ${audience} by ${req.user.id}`,
    );
    return finish(
      { accountEmail: email, createdUserId: String(made._id) },
      {
        accountCreated: true,
        email,
        loginId,
        phone: phone || null,
        usesPhoneLogin: placeholder,
        tempPassword: password,
        sight: madeSight === undefined ? null : madeSight,
        welcomeCall: placeholder ? { phone, name, password } : undefined,
        readyMessage:
          `Hey ${name} -- you're in, and your account is already made. Go to ${domain} and sign ` +
          `in with ${loginId}, password ${password}.` +
          (phone && !placeholder
            ? ` Your phone number ${prettyPhone(phone)} works in that box too.`
            : '') +
          ` Change that password once you're in: it's under your name at the bottom left, then ` +
          `Settings, then Account. Welcome to the family's corner of the internet.`,
      },
    );
  } catch (error) {
    logger.error('[admin-access] approve failed', error);
    res.status(500).json({ error: 'Approve failed' });
  }
});

/** The bridge's own limits, mirrored so a refusal comes before any reset. The gap also covers a
 * call still in progress: ringing, the voicemail check and the 300-second call limit, so "Call
 * again" can never replace the password while the last call is still reading it. */
const CALL_AGAIN_GAP_MS = 7 * 60 * 1000;
const CALLS_PER_DAY = 3;

/**
 * Why "Call again" must wait, from this request's own record of placed
 * calls, or null when it may go ahead.
 */
function callAgainRefusal(doc, now = Date.now()) {
  const times = (Array.isArray(doc.welcomeCallTimes) ? doc.welcomeCallTimes : [])
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t));
  if (doc.welcomeCallStatus === 'placed' && doc.welcomeCallAt) {
    times.push(new Date(doc.welcomeCallAt).getTime());
  }
  const recent = [...new Set(times)].filter((t) => now - t < 24 * 60 * 60 * 1000);
  const latest = recent.length ? Math.max(...recent) : 0;
  if (latest && now - latest < CALL_AGAIN_GAP_MS) {
    const secs = Math.max(1, Math.ceil((CALL_AGAIN_GAP_MS - (now - latest)) / 1000));
    return `I called ${doc.name} less than 7 minutes ago, and that call may still be reading their password. Wait about ${Math.ceil(secs / 60)} minutes, then press "Call again".`;
  }
  if (recent.length >= CALLS_PER_DAY) {
    return (
      `${doc.name} has already had ${CALLS_PER_DAY} calls in the last day, which is the most the ` +
      'phone line allows. Try again tomorrow, or read them a password yourself.'
    );
  }
  return null;
}

/* ── CALL AGAIN (Oct 29 2026) ────────────────────────────────────────────────
 * For a phone-only account that was approved but may never have got in --
 * David, approved Oct 21 before welcome calls existed, never signed in. The
 * old temporary password was shown once and never stored, so it cannot be
 * read to him. This makes a NEW one (stored exactly the way approval stores
 * one), signs out any session on the old one, then calls and reads the new
 * one. Kade's page asks her to confirm first, because it replaces whatever
 * password the account has now.
 */
router.post('/:id/welcome-call', async (req, res) => {
  try {
    const doc = await KadeAccessRequest.findById(req.params.id).lean();
    if (!doc) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (doc.status !== 'approved' || !doc.createdUserId) {
      return res.status(400).json({
        error: 'There is no account on this request yet. Approve it first; that calls them.',
      });
    }
    /* "They're already signed in": nothing is reset and nobody is called; the
     * card just stops asking her. */
    if (req.body?.skip === true) {
      await KadeAccessRequest.findByIdAndUpdate(doc._id, {
        $set: { welcomeCallStatus: 'not-needed' },
      });
      return res.json({ ok: true, id: String(doc._id), welcomeCallStatus: 'not-needed' });
    }
    const user = await findUser({ _id: doc.createdUserId }, 'email _id name kadePhone');
    if (!user) {
      return res.status(404).json({
        error: 'The account this request made is not there any more.',
      });
    }
    if (!user.kadePhone || !isPlaceholderEmail(user.email)) {
      return res.status(400).json({
        error:
          `${doc.name} signs in with an email address, so a call is not the way in for them. ` +
          'They can use "Forgot your password?" on the sign-in page.',
      });
    }
    const name = String(user.name || doc.name || '').trim();
    const where = prettyPhone(user.kadePhone);
    /* Review fix (Oct 29): nothing about the password changes until we know
     * the call will go out. First our own record of recent calls (the bridge
     * spaces calls to one number 90 s apart and allows 3 a day)... */
    const wait = callAgainRefusal(doc);
    if (wait) {
      return res.status(409).json({
        error: `${wait} Nothing was changed; ${name}'s password still works.`,
        nothingChanged: true,
      });
    }
    /* ...then the bridge itself, asked with dryRun so it checks its limits and
     * its phone setup without calling. An old bridge, a down bridge, a full
     * day: refused here, before the reset. */
    const password = tempPassword();
    const ready = await checkWelcomeCall({ phone: user.kadePhone, name, password });
    if (ready.status !== 'ready') {
      return res.status(409).json({
        error:
          `The call to ${name} can't go out right now (${ready.reason}), so I did not change ` +
          'their password. Nothing was changed; try again later, or help them another way.',
        nothingChanged: true,
      });
    }
    await updateUser(user._id, { password: hashPassword(password) });
    try {
      await deleteAllUserSessions({ userId: String(user._id) });
    } catch (e) {
      logger.warn('[admin-access] could not sign out old sessions (password still reset):', e.message);
    }
    logger.info(`[admin-access] new temporary password for request ${doc._id} by ${req.user.id}`);
    const result = await callAndRecord(doc._id, { phone: user.kadePhone, name, password });
    const domain = process.env.DOMAIN_CLIENT || 'https://kademurdock.com';
    const loginId = where;
    const signIn =
      `Hey ${name} -- go to ${domain} or the Kade AI app and sign in with ${loginId}, ` +
      `password ${password}. Change that password once you're in: it's under your name, then ` +
      'Settings, then Account.';
    /* The check passed but the call itself still failed: the password HAS
     * changed, so say that plainly and hand her the new one to read. */
    const first =
      result.status === 'placed'
        ? `I made ${name} a new password; the old one no longer works. ` +
          callLine(result, name, user.kadePhone)
        : `I made ${name} a new password, so the old one no longer works, but the call to ` +
          `${where} did NOT go through (${result.reason || 'no reason given'}). Read them the new ` +
          'password in the message below yourself, or press "Call again" in a few minutes.';
    return res.json({
      ok: true,
      id: String(doc._id),
      loginId,
      tempPassword: password,
      welcomeCallStatus: result.status,
      readyMessage: first + '\n\n' + signIn,
    });
  } catch (error) {
    logger.error('[admin-access] welcome call failed', error);
    res.status(500).json({ error: 'Calling them again did not work. Try again in a minute.' });
  }
});

/* ── THE ACCOUNT'S SCREEN SETTING (Oct 29 2026, review) ─────────────────────
 * On an approved card with an account, Kade sees the account's current
 * screen setting and can change it here, without approving again.
 * Body {sight: 'sighted' | 'nonvisual' | 'unsaid' | null}. Marked setBy 'admin'.
 */
router.put('/:id/sight', async (req, res) => {
  try {
    const sight = parseSightChoice(req.body ? req.body.sight : undefined);
    if (sight === undefined) {
      return res.status(400).json({ error: "Pick 'sighted', 'nonvisual' or 'unsaid'." });
    }
    const doc = await KadeAccessRequest.findById(req.params.id).lean();
    if (!doc) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (doc.status !== 'approved' || !doc.createdUserId) {
      return res.status(400).json({
        error: 'There is no account on this request yet. Pick it on the card, then approve.',
      });
    }
    const saved = await setSight(doc.createdUserId, { sight }, 'admin');
    logger.info(`[admin-access] screen setting changed for request ${doc._id} by ${req.user.id}`);
    return res.json({ ok: true, id: String(doc._id), accountSight: saved.sight });
  } catch (error) {
    logger.error('[admin-access] screen setting failed', error);
    res.status(500).json({ error: 'Saving the screen setting did not work. Try again in a minute.' });
  }
});

router.post('/:id/deny', async (req, res) => {
  try {
    /* Oct 29 2026 (review): denying an approved request that already made an
     * account would leave the account working and only hide the card. */
    const existing = await KadeAccessRequest.findById(req.params.id).lean();
    if (existing && existing.status === 'approved' && existing.createdUserId) {
      return res.status(409).json({
        error: `${existing.name} already has an account, so denying the request now would not take it away.`,
      });
    }
    const doc = await KadeAccessRequest.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: 'denied',
          decidedAt: new Date(),
          decidedNote: String(req.body?.note || '').slice(0, 500),
        },
      },
      { new: true },
    ).lean();
    if (!doc) return res.status(404).json({ error: 'Request not found' });
    logger.info(`[admin-access] denied "${doc.name}" by ${req.user.id}`);
    res.json({ ok: true, id: String(doc._id) });
  } catch (error) {
    logger.error('[admin-access] deny failed', error);
    res.status(500).json({ error: 'Deny failed' });
  }
});

module.exports = router;
