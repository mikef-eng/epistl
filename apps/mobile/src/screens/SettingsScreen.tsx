import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { colorScheme } from 'nativewind';
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { ApiError, deleteAccount } from '../api/client';
import { clearSession, getEmail } from '../api/session';
import { clearIdentity } from '../crypto/identity';
import { clearAllSessions } from '../crypto/session';
import type { RootStackParamList } from '../navigation/types';
import {
  getNotificationsEnabled,
  getThemePreference,
  saveNotificationsEnabled,
  saveThemePreference,
  type ThemePreference,
} from '../settings/preferences';
import { clearAllMessages } from '../storage/messages';

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
  // Explicit confirmation gate (issue #92): pressing "Delete account" only
  // reveals this step -- it never sends the request itself. The request is
  // only sent once the user has typed their own email back, matching
  // exactly, into `deleteConfirmText`.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  function handleStartDelete() {
    setDeleteError(null);
    setDeleteConfirmText('');
    setConfirmingDelete(true);
  }

  function handleCancelDelete() {
    setConfirmingDelete(false);
    setDeleteConfirmText('');
    setDeleteError(null);
  }

  async function handleConfirmDelete() {
    setDeleteError(null);
    try {
      // Only sent once the confirmation gate above has been satisfied --
      // the "Confirm delete" button below is disabled until then.
      await deleteAccount();
    } catch (err) {
      // Failure: leave every local store untouched (no wipe, no nav reset)
      // and surface an inline error, per issue #92 -- there is no point
      // discarding local crypto/session/message state for an account that
      // the server says still exists.
      setDeleteError(err instanceof ApiError ? err.message : 'Something went wrong');
      return;
    }

    // Success (`204`): a full local wipe, strictly more thorough than log
    // out -- session (as log out does) plus crypto identity, ratchet
    // sessions, and message history, since there is no server-side account
    // left to log back into.
    await Promise.all([clearSession(), clearIdentity(), clearAllSessions(), clearAllMessages()]);
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

      <View className="border-t border-gray-200 px-4 py-4 dark:border-gray-700">
        <Text className="mb-2 text-sm font-semibold text-gray-500 dark:text-gray-400">
          Danger zone
        </Text>

        {deleteError !== null ? (
          <Text className="mb-2 text-center text-red-500">{deleteError}</Text>
        ) : null}

        {confirmingDelete ? (
          <View>
            <Text className="mb-2 text-sm text-black dark:text-white">
              This permanently deletes your account and all local data on this device. Type{' '}
              {email ?? 'your email'} to confirm.
            </Text>
            <TextInput
              accessibilityLabel="Confirm account deletion"
              placeholder="Type your email to confirm"
              autoCapitalize="none"
              value={deleteConfirmText}
              onChangeText={setDeleteConfirmText}
              className="mb-3 rounded-lg border border-gray-300 px-3 py-2 text-black dark:border-gray-600 dark:text-white"
            />
            <View className="flex-row">
              <Pressable
                accessibilityRole="button"
                onPress={handleCancelDelete}
                className="mr-2 flex-1 items-center rounded-lg bg-gray-200 py-3 dark:bg-gray-700"
              >
                <Text className="text-base font-semibold text-black dark:text-white">Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: deleteConfirmText !== email }}
                disabled={deleteConfirmText !== email}
                onPress={handleConfirmDelete}
                className={`flex-1 items-center rounded-lg py-3 ${
                  deleteConfirmText === email ? 'bg-red-700' : 'bg-red-300'
                }`}
              >
                <Text className="text-base font-semibold text-white">Confirm delete</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={handleStartDelete}
            className="items-center rounded-lg border border-red-700 py-3"
          >
            <Text className="text-base font-semibold text-red-700">Delete account</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
