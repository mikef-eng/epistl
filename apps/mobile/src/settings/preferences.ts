/**
 * Persists and retrieves non-sensitive local UI preferences (theme choice,
 * notification toggle) via `@react-native-async-storage/async-storage`.
 * `expo-secure-store` (see `../api/session.ts`) is reserved for actual
 * secrets — these prefs don't need OS-keychain backing. Independent of any
 * screen or theme-application logic so it can be unit tested in isolation,
 * following the same pattern as `../api/session.ts`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_PREFERENCE_KEY = 'epistl.theme_preference';
export const NOTIFICATIONS_ENABLED_KEY = 'epistl.notifications_enabled';

export async function saveThemePreference(pref: ThemePreference): Promise<void> {
  await AsyncStorage.setItem(THEME_PREFERENCE_KEY, pref);
}

export async function getThemePreference(): Promise<ThemePreference> {
  const stored = await AsyncStorage.getItem(THEME_PREFERENCE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') {
    return stored;
  }
  return 'system';
}

export async function saveNotificationsEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(NOTIFICATIONS_ENABLED_KEY, String(enabled));
}

export async function getNotificationsEnabled(): Promise<boolean> {
  const stored = await AsyncStorage.getItem(NOTIFICATIONS_ENABLED_KEY);
  return stored === 'true';
}
