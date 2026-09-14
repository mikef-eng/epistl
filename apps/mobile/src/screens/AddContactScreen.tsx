import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { addContact, ApiError } from '../api/client';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'AddContact'>;

const ERROR_MESSAGES: Record<string, string> = {
  user_not_found: 'No user with that email',
  already_added: 'Already in your contacts',
  cannot_add_self: "You can't add yourself",
};

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    return ERROR_MESSAGES[err.code] ?? 'Something went wrong';
  }
  return 'Something went wrong';
}

export default function AddContactScreen({ navigation }: Props) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isEmailValid = email.length > 0 && email.includes('@');
  const isSubmitDisabled = !isEmailValid || submitting;

  async function handleSubmit() {
    if (isSubmitDisabled) {
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await addContact(email);
      navigation.navigate('Contacts');
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View className="flex-1 bg-white px-6 pt-6 dark:bg-black">
      <Text className="mb-6 text-lg font-semibold text-black dark:text-white">Add contact</Text>

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

      {error !== null ? <Text className="mb-4 text-center text-red-500">{error}</Text> : null}

      <Pressable
        accessibilityRole="button"
        disabled={isSubmitDisabled}
        onPress={handleSubmit}
        className={`items-center rounded-lg py-3 ${isSubmitDisabled ? 'bg-blue-200' : 'bg-blue-500'}`}
      >
        <Text className="text-base font-semibold text-white">Add</Text>
      </Pressable>
    </View>
  );
}
