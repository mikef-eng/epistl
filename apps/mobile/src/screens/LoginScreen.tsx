import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { ApiError, login, signup, type AuthUser } from '../api/client';
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

    setError(null);
    setSubmitting(true);
    try {
      const data = mode === 'login' ? await login(email, password) : await signup(email, password);
      const userId = userIdOf(data.user);
      if (userId !== null) {
        // Persisted so later screens (e.g. `ChatScreen`, issue #41) can
        // identify "self" for PQXDH session establishment and envelope AAD
        // binding without re-deriving it from the login/signup response.
        await saveUserId(userId);
        // `ensureKeysRegistered` already swallows its own errors (network,
        // etc.) so a failed upload never blocks login/signup from
        // completing; this `catch` is defense-in-depth in case that
        // contract is ever violated.
        await ensureKeysRegistered(userId).catch(() => undefined);
      }
      navigation.replace('Contacts');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View className="flex-1 justify-center bg-white px-6">
      <Text className="mb-6 text-center text-2xl font-bold text-blue-500">Epistl</Text>

      <TextInput
        className="mb-3 rounded-lg border border-gray-300 px-4 py-3 text-base"
        placeholder="Email"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        className="mb-4 rounded-lg border border-gray-300 px-4 py-3 text-base"
        placeholder="Password"
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
          isSubmitDisabled ? 'bg-blue-200' : 'bg-blue-500'
        }`}
      >
        <Text className="text-base font-semibold text-white">
          {mode === 'login' ? 'Log in' : 'Sign up'}
        </Text>
      </Pressable>

      <Pressable onPress={toggleMode}>
        <Text className="text-center text-blue-500">
          {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Log in'}
        </Text>
      </Pressable>
    </View>
  );
}
