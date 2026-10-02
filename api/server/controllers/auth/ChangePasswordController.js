/* ----------------------------------------------------------------------------
 * CHANGE PASSWORD WHILE SIGNED IN (Oct 2 2026).
 *
 * The iPhone's Change password screen asked /requestPasswordReset for a link
 * and spent it at once. Since Sep 8 that route never hands the link back (it
 * emails it, which is right), so the screen has failed for everyone. This is
 * the honest door: a signed-in person proves the current password and sets a
 * new one. The session stays signed in; nothing is emailed.
 * -------------------------------------------------------------------------- */
const bcrypt = require('bcryptjs');
const { logger } = require('@librechat/data-schemas');
const { comparePassword } = require('@librechat/api');
const { findUser, updateUser } = require('~/models');

const changePasswordController = async (req, res) => {
  const userId = req.user && (req.user.id || req.user._id);
  const { currentPassword, newPassword } = req.body || {};
  const minLength = parseInt(process.env.MIN_PASSWORD_LENGTH, 10) || 8;
  if (!userId) {
    return res.status(401).json({ message: 'Sign in first.' });
  }
  if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 128) {
    return res.status(400).json({ message: 'Type your current password.' });
  }
  if (
    typeof newPassword !== 'string' ||
    newPassword.length < minLength ||
    newPassword.length > 128 ||
    !newPassword.trim()
  ) {
    return res
      .status(400)
      .json({ message: `The new password needs ${minLength} to 128 characters.` });
  }
  try {
    const user = await findUser({ _id: userId }, '+password');
    if (!user || !user.password) {
      return res
        .status(400)
        .json({ message: 'This account has no password to change. Ask Kade to set one.' });
    }
    const isMatch = await comparePassword(user, currentPassword, { compare: bcrypt.compare });
    if (!isMatch) {
      logger.warn(`[changePassword] current password did not match [ID: ${userId}] [IP: ${req.ip}]`);
      return res.status(403).json({ message: 'That is not your current password. Nothing changed.' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ message: 'The new password is the same as the old one.' });
    }
    await updateUser(userId, { password: bcrypt.hashSync(newPassword, 10) });
    logger.info(`[changePassword] password changed [ID: ${userId}] [IP: ${req.ip}]`);
    return res.status(200).json({ ok: true, message: 'Password changed.' });
  } catch (err) {
    logger.error(`[changePassword] failed [ID: ${userId}]: ${err && err.message}`);
    return res.status(500).json({ message: 'The password could not be changed. Nothing changed.' });
  }
};

module.exports = { changePasswordController };
