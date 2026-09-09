import { z } from 'zod';

/**
 * Zod email validation schema
 * Uses Zod's built-in email validation which is more robust than simple regex
 * Based on: https://zod.dev/api?id=emails
 */
export const emailSchema = z.string().email();

/**
 * Validates an email address using Zod
 * @param email - The email address to validate
 * @param errorMessage - Optional custom error message (defaults to Zod's message)
 * @returns true if valid, error message if invalid
 */
export const validateEmail = (email: string, errorMessage?: string): true | string => {
  if (!email || email.trim() === '') {
    return true;
  }

  const result = emailSchema.safeParse(email);
  return (
    result.success ||
    errorMessage ||
    result.error.errors[0]?.message ||
    'Please enter a valid email address'
  );
};

/**
 * KADE-AI (Part 143, Sep 8 2026). Her words: "you should make it accept a
 * phone as login too. Not everyone has both, one, or the other. It's not like
 * we are texting or emailing them."
 *
 * The login box is one field. This platform mails nobody, so an address here
 * is a NAME, not a channel -- and a phone number is just as good a name. The
 * server (api/server/utils/kadeLoginId.js) holds the matching opinion: ten
 * digits, or eleven starting with a one.
 */
const isPhoneNumber = (value: string): boolean => {
  const digits = value.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
};

/**
 * Validates what somebody typed into the single login field: an email address
 * or a phone number. Empty passes, the same way validateEmail does -- the
 * required rule owns that message.
 */
export const validateLoginIdentifier = (value: string, errorMessage?: string): true | string => {
  if (!value || value.trim() === '') {
    return true;
  }
  if (isPhoneNumber(value.trim())) {
    return true;
  }
  return emailSchema.safeParse(value).success || errorMessage || 'Enter your email address or phone number';
};
