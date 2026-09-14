import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { colorScheme } from 'nativewind';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { clearSession, getEmail } from '../api/session';
import type { RootStackParamList } from '../navigation/types';
import {
  getNotificationsEnabled,
  getThemePreference,
  saveNotificationsEnabled,
  saveThemePreference,
  type ThemePreference,
} from '../settings/preferences';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function SettingsScreen({ navigation }: Props) {
  const [theme, setTheme] = useState<ThemePreference>('system');
  const [email, setEmail] = useState<string | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);

  // Loads all three persisted values once on mount. Each is independent of
  // the others, so a single `Promise.all` keeps the initial render simple
  // without implying any ordering dependency between them.
  useEffect(() => {
    let cancelled = false;
    Promise.all([getThemePreference(), getEmail(), getNotificationsEnabled()]).then(
      ([storedTheme, storedEmail, storedNotificationsEnabled]) => {
        if (cancelled) {
          return;
        }
        setTheme(storedTheme);
        setEmail(storedEmail);
        setNotificationsEnabled(storedNotificationsEnabled);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSelectTheme(value: ThemePreference) {
    setTheme(value);
    // Applied immediately via NativeWind's `colorScheme.set` (instant
    // re-render, no restart needed) in addition to being persisted so
    // `App.tsx` can re-apply it on the next cold start.
    colorScheme.set(value);
    await saveThemePreference(value);
  }

  async function handleToggleNotifications() {
    const next = !notificationsEnabled;
    setNotificationsEnabled(next);
    await saveNotificationsEnabled(next);
  }

  async function handleLogOut() {
    // Deliberately only `clearSession()` -- never `../crypto/identity.ts`,
    // `../crypto/session.ts`, or `../storage/messages.ts`. Those are tied to
    // the device's cryptographic identity, not the auth session; logging
    // back in as the same user should find them intact.
    await clearSession();
    // A reset, not `navigate`, so the back gesture can't return to
    // authenticated screens afterward.
    navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
  }

  return (
    <View className="flex-1 bg-white dark:bg-black">
      <View className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <Text className="text-lg font-semibold text-black dark:text-white">Settings</Text>
      </View>

      <View className="border-b border-gray-200 px-4 py-4 dark:border-gray-700">
        <Text className="mb-2 text-sm font-semibold text-gray-500 dark:text-gray-400">
          Appearance
        </Text>
        <View className="flex-row">
          {THEME_OPTIONS.map((option) => {
            const selected = theme === option.value;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => handleSelectTheme(option.value)}
                className={`mr-2 rounded-lg px-4 py-2 ${
                  selected ? 'bg-blue-500' : 'bg-gray-100 dark:bg-gray-800'
                }`}
              >
                <Text
                  className={`text-base ${
                    selected ? 'text-white' : 'text-black dark:text-white'
                  }`}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View className="border-b border-gray-200 px-4 py-4 dark:border-gray-700">
        <Text className="mb-2 text-sm font-semibold text-gray-500 dark:text-gray-400">
          Account
        </Text>
        <Text className="text-base text-black dark:text-white">{email ?? ''}</Text>
      </View>

      <View className="border-b border-gray-200 px-4 py-4 dark:border-gray-700">
        <View className="flex-row items-center justify-between">
          <Text className="text-base text-black dark:text-white">Notifications</Text>
          <Pressable
            accessibilityRole="switch"
            accessibilityLabel="Notifications"
            accessibilityState={{ checked: notificationsEnabled }}
            onPress={handleToggleNotifications}
            className={`rounded-full px-3 py-1 ${
              notificationsEnabled ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700'
            }`}
          >
            <Text
              className={`text-sm font-semibold ${
                notificationsEnabled ? 'text-white' : 'text-black dark:text-white'
              }`}
            >
              {notificationsEnabled ? 'On' : 'Off'}
            </Text>
          </Pressable>
        </View>
        {/* Not wired to any notification behavior -- no push notification
            system exists anywhere in this app yet. */}
        <Text className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Coming soon -- not yet functional
        </Text>
      </View>

      <View className="px-4 py-4">
        <Pressable
          accessibilityRole="button"
          onPress={handleLogOut}
          className="items-center rounded-lg bg-red-500 py-3"
        >
          <Text className="text-base font-semibold text-white">Log out</Text>
        </Pressable>
      </View>
    </View>
  );
}
