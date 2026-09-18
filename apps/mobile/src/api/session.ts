/**
 * Persists and retrieves the backend session token on-device via
 * `expo-secure-store`. Independent of any screen or API client function so
 * it can be unit tested (and reused) in isolation.
 */
import * as SecureStore from 'expo-secure-store';

export const SESSION_TOKEN_KEY = 'epistl.session_token';
/** The authenticated user's own id (issue #41), needed alongside the
 * session token: PQXDH session establishment (`../crypto/session.ts`'s
 * `initiateSession`/`receiveHandshake`) and envelope AAD binding
 * (`../crypto/envelope.ts`) both need to know "who am I", not just "am I
 * logged in". Persisted the same way as the token so it survives restarts,
 * rather than being re-derived from the login/signup response each time. */
export const SESSION_USER_ID_KEY = 'epistl.session_user_id';
/** The authenticated user's own email (issue #125), needed so
 * `SettingsScreen`'s read-only account info section can display it without
 * a network round trip. Persisted the same way as the token/user id, from
 * `AuthResponse.user`'s email at `../api/client.ts`'s `login`/`signup`
 * success. */
export const SESSION_EMAIL_KEY = 'epistl.session_email';
/** The authenticated user's own avatar serving path (issue #182), as
 * returned by `../api/client.ts`'s `uploadAvatar` on a successful
 * `POST /api/avatar/confirm` -- persisted the same way as the
 * token/user id/email so a future cold start has it without a network
 * round trip, even though it isn't otherwise read back for rendering
 * (every avatar display, including the current user's own in
 * `SettingsScreen`, always hits `GET /api/avatar/{user_id}` directly and
 * falls back to the initial circle on failure -- see `../components/Avatar.tsx`). */
export const SESSION_AVATAR_PATH_KEY = 'epistl.session_avatar_path';

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_TOKEN_KEY, token);
}

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_TOKEN_KEY);
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
}

export async function saveUserId(userId: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_USER_ID_KEY, userId);
}

export async function getUserId(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_USER_ID_KEY);
}

export async function saveEmail(email: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_EMAIL_KEY, email);
}

export async function getEmail(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_EMAIL_KEY);
}

export async function saveAvatarPath(path: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_AVATAR_PATH_KEY, path);
}

export async function getAvatarPath(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_AVATAR_PATH_KEY);
}

/** Clears the token, user id, email, and avatar path keys together in one
 * call (issue #125's log-out flow) so a future caller can't forget one by
 * clearing them individually at each call site. Deliberately does not
 * touch `../crypto/identity.ts`, `../crypto/session.ts`, or
 * `../storage/messages.ts` -- those are tied to the device's cryptographic
 * identity, not the auth session, and logging back in as the same user
 * should find them intact. */
export async function clearSession(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(SESSION_TOKEN_KEY),
    SecureStore.deleteItemAsync(SESSION_USER_ID_KEY),
    SecureStore.deleteItemAsync(SESSION_EMAIL_KEY),
    SecureStore.deleteItemAsync(SESSION_AVATAR_PATH_KEY),
  ]);
}
