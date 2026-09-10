/**
 * Shared password policy for every place a user sets or changes their
 * own password (signup, settings → change password). Single source
 * of truth for the minimum length and character requirements so the
 * two forms can't silently drift apart.
 *
 * This is enforced client-side only — Supabase Auth's own project-
 * level minimum (6 chars by default) still applies underneath as a
 * floor, but callers should never be able to submit a weaker
 * password than this policy allows.
 */
export const PASSWORD_MIN_LENGTH = 8;

export function hasUppercase(password: string): boolean {
  return /[A-Z]/.test(password);
}

export function hasDigit(password: string): boolean {
  return /[0-9]/.test(password);
}

export function meetsPasswordPolicy(password: string): boolean {
  return (
    password.length >= PASSWORD_MIN_LENGTH &&
    hasUppercase(password) &&
    hasDigit(password)
  );
}
