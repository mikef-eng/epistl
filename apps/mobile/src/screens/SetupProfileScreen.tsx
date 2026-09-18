import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useColorScheme } from 'nativewind';
import { useEffect, useState } from 'react';
import { Animated, Image, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, UsernameTakenError, signup, uploadAvatar, type AuthUser } from '../api/client';
import { saveAvatarPath, saveUserId } from '../api/session';
import { pickAvatarImage } from '../avatar/pickImage';
import { ensureKeysRegistered } from '../crypto/keyRegistration';
import type { RootStackParamList } from '../navigation/types';
import { isValidUsernameFormat, USERNAME_FORMAT_ERROR } from '../validation/username';

/** Mirrors `LoginScreen.tsx`'s own `userIdOf` for the same opaque
 * `AuthResponse.user` shape. */
function userIdOf(user: AuthUser): string | null {
  return typeof user.id === 'string' ? user.id : null;
}

function messageFor(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

type Props = NativeStackScreenProps<RootStackParamList, 'SetupProfile'>;

/**
 * Shown right after tapping "Sign up" on `LoginScreen` (issue #216) --
 * collects the required username (and an optional avatar) that
 * `POST /signup` needs but `LoginScreen`'s form never gathered, before the
 * account is actually created. `route.params` carries the email/password
 * entered on `LoginScreen`; nothing here persists them independently, so a
 * user who backs out loses nothing beyond re-typing them.
 *
 * Sequencing on submit: `signup()` first (creates the account), then --
 * only if an avatar was picked -- `uploadAvatar()` using the session it
 * just created. A picked avatar is only ever held locally (`avatarUri`) and
 * previewed directly, never uploaded, until the account exists; this
 * mirrors `SettingsScreen.tsx`'s existing upload flow but necessarily
 * defers the upload step, since `uploadAvatar` requires a session token
 * this screen doesn't have until `signup()` resolves.
 */
export default function SetupProfileScreen({ navigation, route }: Props) {
  const { email, password } = route.params;
  const insets = useSafeAreaInsets();
  const { colorScheme: activeColorScheme } = useColorScheme();
  const isDark = activeColorScheme === 'dark';
  const headerIconColor = isDark ? '#FFFFFF' : '#000000';
  const avatarIconColor = isDark ? '#D1D5DB' : '#6B7280';

  const [username, setUsername] = useState('');
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  // The one deliberate motion moment this screen uses (per the design
  // brief): a small scale-in confirmation when a photo is picked, not a
  // scattering of hover/entrance effects. Skipped entirely on mount (only
  // fires when `avatarUri` actually changes to a new picked value). A
  // lazy `useState` initializer (not `useRef(...).current`, which the
  // repo's `react-hooks/refs` lint rule flags as an unsafe render-time ref
  // read) keeps one stable `Animated.Value` identity across re-renders.
  const [avatarScale] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (avatarUri === null) {
      return;
    }
    avatarScale.setValue(0.85);
    Animated.spring(avatarScale, {
      toValue: 1,
      useNativeDriver: true,
      friction: 5,
    }).start();
  }, [avatarUri, avatarScale]);

  const isSubmitDisabled = username.length === 0 || submitting;

  async function handlePickAvatar() {
    setAvatarError(null);

    const picked = await pickAvatarImage();
    if (picked.status === 'permission_denied') {
      setAvatarError('Permission to access photos is required');
      return;
    }
    if (picked.status === 'canceled') {
      return;
    }

    setAvatarUri(picked.uri);
  }

  async function handleSubmit() {
    if (isSubmitDisabled) {
      return;
    }

    if (!isValidUsernameFormat(username)) {
      setUsernameError(USERNAME_FORMAT_ERROR);
      return;
    }

    setUsernameError(null);
    setSubmitting(true);
    try {
      const data = await signup(email, password, username);
      const userId = userIdOf(data.user);
      if (userId !== null) {
        // Persisted so later screens (e.g. `ChatScreen`, issue #41) can
        // identify "self" for PQXDH session establishment and envelope AAD
        // binding without re-deriving it from the signup response --
        // mirrors `LoginScreen.tsx`'s own login/signup handling.
        await saveUserId(userId);
        // `ensureKeysRegistered` already swallows its own errors (network,
        // etc.) so a failed upload never blocks signup from completing;
        // this `catch` is defense-in-depth in case that contract is ever
        // violated.
        await ensureKeysRegistered(userId).catch(() => undefined);
      }

      // The account now exists -- if a photo was picked earlier, upload it
      // now. A failure here is shown inline but never blocks navigation:
      // the account is already created, so the user can always retry from
      // Settings later (matching `ensureKeysRegistered`'s existing
      // non-blocking-failure convention referenced above).
      if (avatarUri !== null) {
        try {
          const { image } = await uploadAvatar(avatarUri);
          await saveAvatarPath(image);
        } catch (err) {
          setAvatarError(messageFor(err));
        }
      }

      navigation.replace('Main');
    } catch (err) {
      if (err instanceof UsernameTakenError) {
        setUsernameError('That username is already taken -- try another');
      } else {
        setUsernameError(messageFor(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View className="flex-1 bg-white dark:bg-black">
      <View
        style={{ paddingTop: insets.top }}
        className="flex-row items-center justify-between px-6 pt-3"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => navigation.goBack()}
        >
          <Ionicons name="arrow-back" size={24} color={headerIconColor} />
        </Pressable>
        {/* A lightweight two-step progress cue (credentials done, profile
            setup current) -- not numbered markers, since two dots already
            read clearly as "step 2 of 2" without needing digits. */}
        <View className="flex-row items-center" accessibilityLabel="Step 2 of 2">
          <View className="h-1.5 w-1.5 rounded-full bg-gray-300 dark:bg-gray-600" />
          <View className="ml-1.5 h-1.5 w-4 rounded-full bg-[#8B2F4B]" />
        </View>
      </View>

      {/* Content and the submit button below flow together as one block,
          nudged above center via the flex-ratio spacers around it -- the
          same convention `LoginScreen.tsx` uses -- rather than top-anchoring
          the content and pinning the button to the screen's bottom edge,
          which left a large dead gap on a screen this short. */}
      <View style={{ flex: 0.5 }} />
      <View className="px-6">
        <Text className="text-center text-2xl font-semibold text-black dark:text-white">
          Set up your profile
        </Text>
        <Text className="mb-8 mt-2 text-center text-sm text-gray-500 dark:text-gray-400">
          Choose a username so friends can find and add you.
        </Text>

        <TextInput
          className="rounded-lg border border-gray-300 px-4 py-3 text-base text-black dark:border-gray-700 dark:text-white"
          placeholder="Username"
          placeholderTextColor="#9CA3AF"
          autoCapitalize="none"
          autoCorrect={false}
          value={username}
          onChangeText={(value) => {
            setUsername(value);
            setUsernameError(null);
          }}
        />
        {usernameError !== null ? (
          <Text className="mt-2 text-sm text-red-500">{usernameError}</Text>
        ) : null}

        <View className="mt-10 items-center">
          <Animated.View style={{ transform: [{ scale: avatarScale }] }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={avatarUri !== null ? 'Change photo' : 'Add a photo'}
              onPress={handlePickAvatar}
              className="h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
            >
              {avatarUri !== null ? (
                <Image source={{ uri: avatarUri }} className="h-20 w-20 rounded-full" />
              ) : (
                <Ionicons name="camera-outline" size={26} color={avatarIconColor} />
              )}
            </Pressable>
          </Animated.View>
          <Text className="mt-2 text-sm font-semibold text-[#8B2F4B]">
            {avatarUri !== null ? 'Change photo' : 'Add a photo'}
          </Text>
          <Text className="mt-1 text-center text-xs text-gray-500 dark:text-gray-400">
            Optional -- you can always add one later in Settings
          </Text>
          {avatarError !== null ? (
            <Text className="mt-2 text-center text-sm text-red-500">{avatarError}</Text>
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          disabled={isSubmitDisabled}
          onPress={handleSubmit}
          className={`mt-10 items-center rounded-lg py-3 ${
            isSubmitDisabled ? 'bg-[#8B2F4B]/35 dark:bg-[#8B2F4B]/25' : 'bg-[#8B2F4B]'
          }`}
        >
          <Text className="text-base font-semibold text-white">
            {submitting ? 'Creating account...' : 'Create account'}
          </Text>
        </Pressable>
      </View>
      <View style={{ flex: 1 }} />
    </View>
  );
}
