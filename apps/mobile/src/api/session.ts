/**
 * Persists and retrieves the backend session token on-device via
 * `expo-secure-store`. Independent of any screen or API client function so
 * it can be unit tested (and reused) in isolation.
 */
import * as SecureStore from 'expo-secure-store';

export const SESSION_TOKEN_KEY = 'epistl.session_token';

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_TOKEN_KEY, token);
}

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_TOKEN_KEY);
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
}
