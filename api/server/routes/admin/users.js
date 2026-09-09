const bcrypt = require('bcryptjs');
const express = require('express');
const { createAdminUsersHandlers } = require('@librechat/api');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { classifyLoginId } = require('~/server/utils/kadeLoginId');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();

const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireReadUsers = requireCapability(SystemCapabilities.READ_USERS);
// const requireManageUsers = requireCapability(SystemCapabilities.MANAGE_USERS);

const handlers = createAdminUsersHandlers({
  findUsers: db.findUsers,
  countUsers: db.countUsers,
  deleteUserById: db.deleteUserById,
  deleteConfig: db.deleteConfig,
  deleteAclEntries: db.deleteAclEntries,
});

router.use(requireJwtAuth, requireAdminAccess);

router.get('/', requireReadUsers, handlers.listUsers);
router.get('/search', requireReadUsers, handlers.searchUsers);
// router.delete('/:id', requireManageUsers, handlers.deleteUser);

/* ── SET SOMEBODY'S PASSWORD (Part 143, Sep 8 2026) ────────────────────────
 * Kade, wanting to set her sister's password the evening the door learned to
 * make accounts. There was no way to do it: ALLOW_PASSWORD_RESET is off on
 * this deployment, so /api/auth/requestPasswordReset answers "Password reset
 * is not allowed", and nothing else on the platform could touch a password.
 * Meanwhile the welcome message the front door now sends says, in her voice,
 * "tell me and I'll reset it for you" — a promise the platform could not
 * keep. This keeps it.
 *
 * Deliberately hers alone: the admin router above already demands a signed-in
 * account with ACCESS_ADMIN before any of this runs. The new password is
 * never echoed back, never logged, and every existing session for that person
 * is dropped so an old token cannot outlive the change.
 *
 * ⚠️ THE FLOOR IS THE LOGIN BOX'S FLOOR, and that is the point of checking it
 * here. MIN_PASSWORD_LENGTH gates the LOGIN schema, not just registration —
 * so a password of six characters can be stored happily and then refused at
 * sign-in before it is ever compared, which locks the person out of their own
 * account with no error that names the cause. (Found the hard way: "Des123"
 * came back as "password: String must contain at least 8 character(s)".)
 * Refusing it here is the difference between a clear no and a silent trap.
 */
const MIN_PASSWORD_LENGTH = parseInt(process.env.MIN_PASSWORD_LENGTH, 10) || 8;

router.post('/set-password', async (req, res) => {
  try {
    const identifier = String(req.body?.identifier || '').trim();
    const password = String(req.body?.password || '');
    if (!identifier) {
      return res.status(400).json({ error: 'Who? Pass identifier: an email address, a phone number, or their id.' });
    }
    if (password.length < MIN_PASSWORD_LENGTH || password.trim().length === 0) {
      return res.status(400).json({
        error:
          `That password is ${password.length} characters, and the sign-in box refuses anything ` +
          `under ${MIN_PASSWORD_LENGTH} — it would lock them out. Pick a longer one.`,
      });
    }
    if (password.length > 128) {
      return res.status(400).json({ error: 'That password is over 128 characters.' });
    }

    /* An email, a phone number, or the raw account id — whichever she has. */
    const id = classifyLoginId(identifier);
    const user =
      id.kind === 'email'
        ? await db.findUser({ email: id.email }, 'email _id name kadePhone')
        : id.kind === 'phone'
          ? await db.findUser({ kadePhone: id.phone }, 'email _id name kadePhone')
          : await db.findUser({ _id: identifier }, 'email _id name kadePhone').catch(() => null);
    if (!user) {
      return res.status(404).json({ error: `Nobody here goes by "${identifier}".` });
    }

    await db.updateUser(user._id, { password: bcrypt.hashSync(password, 10) });
    /* A changed password ends the old sessions, the same way a reset does. */
    try {
      await db.deleteAllUserSessions({ userId: user._id });
    } catch (e) {
      logger.warn('[admin-users] set-password: sessions not cleared:', e.message);
    }
    logger.info(`[admin-users] password set for ${user.email} by ${req.user.id}`);
    res.json({
      ok: true,
      id: String(user._id),
      name: user.name,
      email: user.email,
      /* What they type into the one login box now. */
      signsInWith: user.kadePhone ? [user.email, user.kadePhone] : [user.email],
    });
  } catch (error) {
    logger.error('[admin-users] set-password failed', error);
    res.status(500).json({ error: 'Could not set that password.' });
  }
});

module.exports = router;
