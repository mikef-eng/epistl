import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as ImagePicker from 'expo-image-picker';
import { colorScheme, useColorScheme } from 'nativewind';
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, UsernameTakenError, deleteAccount, updateUsername, uploadAvatar } from '../api/client';
import {
  clearSession,
  getEmail,
  getUserId,
  getUsername,
  saveAvatarPath,
  saveUsername,
} from '../api/session';
import Avatar from '../components/Avatar';
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

/** First letter of the account's own email, uppercased, for the avatar
 * preview's fallback -- matches `ConversationsScreen`/`FriendsScreen`/
 * `ChatScreen`'s existing `initialFor`. */
function initialFor(email: string): string {
  return email.trim().charAt(0).toUpperCase() || '?';
}

function messageFor(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

/** Client-side mirror of `apps/api/src/username.rs`'s `is_valid_username`
 * (3-32 characters, letters/digits/underscore only) -- run before ever
 * calling `updateUsername` so an obviously invalid value never reaches the
 * network, per issue #185's acceptance criteria. The server remains the
 * final authority on format regardless (its own `400 invalid_username`
 * still applies if this check is ever out of sync with it). */
function isValidUsernameFormat(value: string): boolean {
  return /^[A-Za-z0-9_]{3,32}$/.test(value);
}

export default function SettingsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { colorScheme: activeColorScheme } = useColorScheme();
  // Matches the header's existing `text-black dark:text-white` convention --
  // `Ionicons`' `color` prop can't take a NativeWind `className`.
  const headerIconColor = activeColorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const [theme, setTheme] = useState<ThemePreference>('system');
  const [email, setEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  // Username edit control (issue #185): tap-to-edit, matching the delete
  // account confirmation step's inline `TextInput` pattern below.
  // `usernameDraft`/`usernameError` are reset each time editing starts;
  // `usernameError` is deliberately left in place across a failed submit so
  // the user can see why before retrying, and cleared again once they
  // start over.
  const [editingUsername, setEditingUsername] = useState(false);
  const [usernameDraft, setUsernameDraft] = useState('');
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  // Explicit confirmation gate (issue #92): pressing "Delete account" only
  // reveals this step -- it never sends the request itself. The request is
  // only sent once the user has typed their own email back, matching
  // exactly, into `deleteConfirmText`.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Avatar upload (issue #182). `avatarVersion` is bumped on every
  // successful upload so `Avatar`'s `cacheBust` forces a fresh
  // `GET /api/avatar/{user_id}` request instead of showing a stale
  // client-cached image for the same URL.
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarVersion, setAvatarVersion] = useState(0);

  // Loads all persisted values once on mount. Each is independent of the
  // others, so a single `Promise.all` keeps the initial render simple
  // without implying any ordering dependency between them.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getThemePreference(),
      getEmail(),
      getUserId(),
      getUsername(),
      getNotificationsEnabled(),
    ]).then(
      ([storedTheme, storedEmail, storedUserId, storedUsername, storedNotificationsEnabled]) => {
        if (cancelled) {
          return;
        }
        setTheme(storedTheme);
        setEmail(storedEmail);
        setUserId(storedUserId);
        setUsername(storedUsername);
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

  function handleStartUsernameEdit() {
    setUsernameDraft(username ?? '');
    setUsernameError(null);
    setEditingUsername(true);
  }

  function handleCancelUsernameEdit() {
    setEditingUsername(false);
    setUsernameDraft('');
    setUsernameError(null);
  }

  async function handleSaveUsername() {
    if (!isValidUsernameFormat(usernameDraft)) {
      setUsernameError(
        'Username must be 3-32 characters: letters, numbers, and underscores only'
      );
      return;
    }

    setUsernameError(null);
    setUsernameSaving(true);
    try {
      const result = await updateUsername(usernameDraft);
      setUsername(result.username);
      await saveUsername(result.username);
      setEditingUsername(false);
    } catch (err) {
      // Failure (409 already-taken or otherwise): leave the previously
      // displayed username untouched, stay in edit mode, and surface an
      // inline error -- never leave `usernameSaving` stuck `true`.
      setUsernameError(
        err instanceof UsernameTakenError ? 'That username is already taken' : messageFor(err)
      );
    } finally {
      setUsernameSaving(false);
    }
  }

  /** Opens the device's photo library (library only -- no camera capture
   * in this issue) and, on a selection, runs issue #189's three-step
   * upload flow via `uploadAvatar`. A single loading flag spans all three
   * steps since `uploadAvatar` itself awaits them sequentially. */
  async function handlePickAvatar() {
    setAvatarError(null);

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setAvatarError('Permission to access photos is required');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
    if (result.canceled || result.assets.length === 0) {
      return;
    }

    setAvatarUploading(true);
    try {
      const { image } = await uploadAvatar(result.assets[0].uri);
      await saveAvatarPath(image);
      setAvatarVersion((prev) => prev + 1);
    } catch (err) {
      setAvatarError(messageFor(err));
    } finally {
      setAvatarUploading(false);
    }
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
      <View
        style={{ paddingTop: insets.top }}
        className="flex-row items-center border-b border-gray-200 px-4 py-3 dark:border-gray-700"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => navigation.goBack()}
          className="mr-3"
        >
          <Ionicons name="arrow-back" size={24} color={headerIconColor} />
        </Pressable>
        <Text className="text-lg font-semibold text-black dark:text-white">Settings</Text>
      </View>

      <View className="items-center border-b border-gray-200 px-4 py-4 dark:border-gray-700">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Change avatar"
          disabled={avatarUploading}
          onPress={handlePickAvatar}
          className="items-center"
        >
          {userId !== null ? (
            <Avatar
              userId={userId}
              fallbackText={initialFor(email ?? '')}
              wrapperClassName="h-20 w-20 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-700"
              imageClassName="h-20 w-20 rounded-full"
              textClassName="text-2xl font-semibold text-black dark:text-white"
              cacheBust={avatarVersion}
            />
          ) : (
            <View className="h-20 w-20 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-700">
              <Text className="text-2xl font-semibold text-black dark:text-white">
                {initialFor(email ?? '')}
              </Text>
            </View>
          )}
          <Text className="mt-2 text-sm font-semibold text-[#8B2F4B]">
            {avatarUploading ? 'Uploading...' : 'Change avatar'}
          </Text>
        </Pressable>
        {avatarError !== null ? (
          <Text className="mt-2 text-center text-sm text-red-500">{avatarError}</Text>
        ) : null}
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
                  selected ? 'bg-[#8B2F4B]' : 'bg-gray-100 dark:bg-gray-800'
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

        <View className="mt-3">
          {editingUsername ? (
            <View>
              <TextInput
                accessibilityLabel="Username"
                placeholder="Username"
                autoCapitalize="none"
                autoCorrect={false}
                value={usernameDraft}
                onChangeText={setUsernameDraft}
                className="mb-2 rounded-lg border border-gray-300 px-3 py-2 text-black dark:border-gray-600 dark:text-white"
              />
              {usernameError !== null ? (
                <Text className="mb-2 text-sm text-red-500">{usernameError}</Text>
              ) : null}
              <View className="flex-row">
                <Pressable
                  accessibilityRole="button"
                  onPress={handleCancelUsernameEdit}
                  className="mr-2 flex-1 items-center rounded-lg bg-gray-200 py-2 dark:bg-gray-700"
                >
                  <Text className="text-base font-semibold text-black dark:text-white">
                    Cancel
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: usernameSaving }}
                  disabled={usernameSaving}
                  onPress={handleSaveUsername}
                  className="flex-1 items-center rounded-lg bg-[#8B2F4B] py-2"
                >
                  <Text className="text-base font-semibold text-white">
                    {usernameSaving ? 'Saving...' : 'Save'}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View className="flex-row items-center justify-between">
              <Text className="text-base text-black dark:text-white">
                {username !== null ? `@${username}` : ''}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit username"
                onPress={handleStartUsernameEdit}
              >
                <Text className="text-sm font-semibold text-[#8B2F4B]">Edit</Text>
              </Pressable>
            </View>
          )}
        </View>
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
              notificationsEnabled ? 'bg-[#8B2F4B]' : 'bg-gray-200 dark:bg-gray-700'
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
