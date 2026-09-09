const express = require('express');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const crypto = require('node:crypto');
const { findUser, updateUser } = require('~/models');
const { registerUser } = require('~/server/services/AuthService');
const { KadeAccessRequest } = require('~/models/kadeAccessRequest');

const router = express.Router();
router.use(requireJwtAuth, requireCapability(SystemCapabilities.ACCESS_ADMIN));

router.get('/', async (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    const filter = status === 'all' ? {} : { status };
    const requests = await KadeAccessRequest.find(filter).sort({ createdAt: -1 }).limit(200).lean();
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
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
/** Readable, sayable, spellable out loud -- this gets read to people, often
 * by a screen reader and sometimes over the phone. No l/1/O/0 collisions. */
const PW_WORDS = [
  'amber', 'anchor', 'basket', 'cedar', 'cactus', 'canyon', 'cobalt', 'copper',
  'dagger', 'denim', 'ember', 'fable', 'fennel', 'garnet', 'ginger', 'harbor',
  'hazel', 'indigo', 'juniper', 'kettle', 'lantern', 'maple', 'marble', 'meadow',
  'nutmeg', 'otter', 'pepper', 'pewter', 'quartz', 'quilt', 'ranger', 'ribbon',
  'saddle', 'sesame', 'sparrow', 'thistle', 'timber', 'tulip', 'velvet', 'walnut',
  'willow', 'yarrow',
];
function tempPassword() {
  const pick = () => PW_WORDS[crypto.randomInt(0, PW_WORDS.length)];
  return `${pick()}-${pick()}-${pick()}-${crypto.randomInt(100, 1000)}`;
}

/** The one place that decides which email an approval will use. */
function emailFor(doc, body) {
  const given = String(body?.email || '').trim();
  if (given) {
    return EMAIL_RE.test(given) ? given.toLowerCase() : null;
  }
  const found = String(doc.contact || '').match(EMAIL_RE);
  return found ? found[0].toLowerCase() : null;
}

/** A phone number hiding in their contact line, for the voice-line signup the
 * ordinary registration path already does. */
function phoneFor(doc, body) {
  const given = String(body?.phone || '').trim();
  const digits = (given || String(doc.contact || '')).replace(/\D/g, '');
  if (digits.length === 10) {
    return digits;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  return null;
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
    const email = emailFor(doc, req.body);
    const note = String(req.body?.note || '').slice(0, 500);

    const finish = async (extra, payload) => {
      await KadeAccessRequest.findByIdAndUpdate(req.params.id, {
        $set: { status: 'approved', audience, decidedAt: new Date(), decidedNote: note, ...extra },
      });
      return res.json({ ok: true, id: String(doc._id), audience, contact: doc.contact, ...payload });
    };

    /* No email, no account -- said in the message itself, because the phone
     * front desk shows the message and nothing else. The code rides along so
     * she is never worse off than she was before this change. */
    if (!email) {
      const code =
        audience === 'child' ? process.env.KADE_REG_CODE_CHILD : process.env.KADE_REG_CODE_ADULT;
      logger.warn(
        `[admin-access] approved "${doc.name}" but no email in "${doc.contact}" -- no account made`,
      );
      return finish(
        {},
        {
          accountCreated: false,
          needsEmail: true,
          readyMessage:
            `I approved ${name}, but I could not make the account: their request left out an ` +
            `email address (they gave "${doc.contact}"). Get an email from them, then open ` +
            `${domain}/access-requests, type it in, and approve again -- that makes the account. ` +
            `If you would rather not wait, they can still sign up at ${domain}/register with the ` +
            `code ${code}.`,
        },
      );
    }

    const existing = await findUser({ email }, 'email _id name');
    if (existing) {
      logger.info(`[admin-access] "${doc.name}" already had an account (${email})`);
      return finish(
        { accountEmail: email, createdUserId: String(existing._id) },
        {
          accountCreated: false,
          alreadyHadAccount: true,
          email,
          readyMessage:
            `Hey ${name} -- you already have an account here under ${email}. Go to ${domain}, ` +
            `sign in, and you're in. If the password is gone, use "Forgot password" on the ` +
            `sign-in page, or tell me and I'll reset it for you.`,
        },
      );
    }

    /* The real registration path, exactly as the front door runs it -- same
     * validation, same balance setup, same child tagging -- so an approved
     * account is not a special second kind of account. */
    const password = tempPassword();
    const result = await registerUser(
      { name, email, password, confirm_password: password },
      { kadeAccountType: audience },
    );
    const made = await findUser({ email }, 'email _id');
    if (!made) {
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
    const phone = phoneFor(doc, req.body);
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

    logger.info(
      `[admin-access] ACCOUNT MADE for "${doc.name}" (${email}) as ${audience} by ${req.user.id}`,
    );
    return finish(
      { accountEmail: email, createdUserId: String(made._id) },
      {
        accountCreated: true,
        email,
        tempPassword: password,
        readyMessage:
          `Hey ${name} -- you're in, and your account is already made. Go to ${domain} and sign ` +
          `in with ${email}, password ${password}. Change that password once you're in: it's ` +
          `under your name at the bottom left, then Settings, then Account. Welcome to the ` +
          `family's corner of the internet.`,
      },
    );
  } catch (error) {
    logger.error('[admin-access] approve failed', error);
    res.status(500).json({ error: 'Approve failed' });
  }
});

router.post('/:id/deny', async (req, res) => {
  try {
    const doc = await KadeAccessRequest.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'denied', decidedAt: new Date(), decidedNote: String(req.body?.note || '').slice(0, 500) } },
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
