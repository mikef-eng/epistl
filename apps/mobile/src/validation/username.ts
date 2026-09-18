/**
 * Client-side mirror of `apps/api/src/username.rs`'s format check, which
 * (per issue #199) delegates directly to Better Auth's own
 * `better_auth_core::utils::username::validate_username` -- 3-30
 * characters, letters/digits/underscore/dot -- the same rule Better Auth's
 * `EmailPasswordPlugin` already enforces at signup. Shared by
 * `SettingsScreen.tsx`'s username edit control (issue #185) and
 * `SetupProfileScreen.tsx`'s required username field (issue #216) so the
 * two never drift out of sync. Run before ever calling `updateUsername`/
 * `signup` so an obviously invalid value never reaches the network. The
 * server remains the final authority on format regardless (its own `400
 * invalid_username` still applies if this check is ever out of sync with
 * it).
 */
export function isValidUsernameFormat(value: string): boolean {
  return /^[A-Za-z0-9_.]{3,30}$/.test(value);
}

/** Shared inline-error copy for an invalid username value -- shown by both
 * `SettingsScreen.tsx` and `SetupProfileScreen.tsx` before any network
 * call is made. */
export const USERNAME_FORMAT_ERROR =
  'Username must be 3-30 characters: letters, numbers, underscores, and dots only';
