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
