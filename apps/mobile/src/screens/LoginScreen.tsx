import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { ApiError, login, type AuthUser } from '../api/client';
import { saveUserId } from '../api/session';
import { ensureKeysRegistered } from '../crypto/keyRegistration';
import type { RootStackParamList } from '../navigation/types';

/** Extracts the authenticated user's id from an `AuthResponse.user`, whose
 * shape is otherwise opaque to this app (it passes through better-auth's
 * user object as-is). */
function userIdOf(user: AuthUser): string | null {
  return typeof user.id === 'string' ? user.id : null;
}

type Props = NativeStackScreenProps<RootStackParamList, 'Login'>;

type Mode = 'login' | 'signup';

export default function LoginScreen({ navigation }: Props) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isSubmitDisabled = email.length === 0 || password.length === 0 || submitting;

  function toggleMode() {
    setMode((current) => (current === 'login' ? 'signup' : 'login'));
    setError(null);
  }

  async function handleSubmit() {
    if (isSubmitDisabled) {
      return;
    }

    if (mode === 'signup') {
      // Issue #216: `POST /signup` requires a `username` this form never
      // collects, so sign-up no longer calls `signup()` directly here --
      // `SetupProfileScreen` collects the required username (and an
      // optional avatar) first, carrying this entered email/password along
      // without creating the account yet.
      navigation.navigate('SetupProfile', { email, password });
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const data = await login(email, password);
      const userId = userIdOf(data.user);
      if (userId !== null) {
        // Persisted so later screens (e.g. `ChatScreen`, issue #41) can
        // identify "self" for PQXDH session establishment and envelope AAD
        // binding without re-deriving it from the login response.
        await saveUserId(userId);
        // `ensureKeysRegistered` already swallows its own errors (network,
        // etc.) so a failed upload never blocks login from completing;
        // this `catch` is defense-in-depth in case that contract is ever
        // violated.
        await ensureKeysRegistered(userId).catch(() => undefined);
      }
      navigation.replace('Main');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View className="flex-1 bg-white px-6 dark:bg-black">
      {/* Spacers push the form to roughly the vertical center-ish third
       * (~40% from the top) instead of dead-centering or bottom-pinning it. */}
      <View style={{ flex: 0.8 }} />
      <View>
        <Text className="text-center text-4xl font-extrabold tracking-wide text-[#8B2F4B] dark:text-[#8B2F4B]">
          Epistl
        </Text>
        <Text className="mb-6 mt-1 text-center text-sm text-gray-500 dark:text-gray-400">
          Private, post-quantum-secure messaging
        </Text>

        <TextInput
          className="mb-3 rounded-lg border border-gray-300 px-4 py-3 text-base text-black dark:border-gray-700 dark:text-white"
          placeholder="Email"
          placeholderTextColor="#9CA3AF"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          className="mb-4 rounded-lg border border-gray-300 px-4 py-3 text-base text-black dark:border-gray-700 dark:text-white"
          placeholder="Password"
          placeholderTextColor="#9CA3AF"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        {error !== null ? <Text className="mb-4 text-center text-red-500">{error}</Text> : null}

        <Pressable
          accessibilityRole="button"
          disabled={isSubmitDisabled}
          onPress={handleSubmit}
          className={`mb-4 items-center rounded-lg py-3 ${
            isSubmitDisabled ? 'bg-[#8B2F4B]/35 dark:bg-[#8B2F4B]/25' : 'bg-[#8B2F4B] dark:bg-[#8B2F4B]'
          }`}
        >
          <Text className="text-base font-semibold text-white">
            {mode === 'login' ? 'Log in' : 'Sign up'}
          </Text>
        </Pressable>

        <Pressable onPress={toggleMode}>
          <Text className="text-center text-[#8B2F4B]">
            {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Log in'}
          </Text>
        </Pressable>

        {__DEV__ ? (
          // Dev-only (issue #67 spike): the only entry point to
          // `QuicSpikeScreen`. Never shown in a production build, and
          // deliberately kept off the real login flow above.
          <Pressable className="mt-8" onPress={() => navigation.navigate('QuicSpike')}>
            <Text className="text-center text-xs text-gray-400">[dev] QUIC spike</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={{ flex: 1.2 }} />
    </View>
  );
}
