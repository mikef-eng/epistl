import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import {
  acceptContactRequest,
  ApiError,
  IncomingRequestExistsError,
  sendContactRequest,
} from '../api/client';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'AddContact'>;

/** Maps `POST /api/contacts/requests` (issue #79) error codes to
 * user-facing copy reflecting request semantics -- `incoming_request_exists`
 * is handled separately below since it carries a `request_id` and renders
 * an "Accept" prompt rather than a plain error message. */
const ERROR_MESSAGES: Record<string, string> = {
  user_not_found: 'No user with that email',
  already_pending: 'You already sent this person a request',
  already_contact: 'Already in your contacts',
  cannot_add_self: "You can't add yourself",
};

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    return ERROR_MESSAGES[err.code] ?? 'Something went wrong';
  }
  return 'Something went wrong';
}

interface CrossedRequest {
  requestId: string;
  email: string;
}

/**
 * "Send a contact request by email" screen (issue #84), replacing the
 * former "add by email" immediate-add flow. On `201` it shows an inline
 * "Request sent" confirmation instead of silently navigating away. On the
 * crossed-request case (`409 incoming_request_exists`, issue #79) it shows
 * an inline "Accept" prompt that calls issue #80's accept endpoint with the
 * request id carried in the error response.
 */
export default function AddContactScreen(_props: Props) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const [crossedRequest, setCrossedRequest] = useState<CrossedRequest | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  const isEmailValid = email.length > 0 && email.includes('@');
  const isSubmitDisabled = !isEmailValid || submitting;

  async function handleSubmit() {
    if (isSubmitDisabled) {
      return;
    }

    setError(null);
    setSent(false);
    setCrossedRequest(null);
    setAcceptError(null);
    setAccepted(false);
    setSubmitting(true);
    try {
      await sendContactRequest(email);
      setSent(true);
    } catch (err) {
      if (err instanceof IncomingRequestExistsError) {
        setCrossedRequest({ requestId: err.requestId, email });
      } else {
        setError(messageFor(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  /** Accepts the crossed request surfaced above. Failure leaves
   * `crossedRequest` (and its prompt) in place with an inline error --
   * mirrors `FriendsScreen`'s accept/decline failure-doesn't-mutate
   * convention. */
  async function handleAccept() {
    if (crossedRequest === null || accepting) {
      return;
    }

    setAcceptError(null);
    setAccepting(true);
    try {
      await acceptContactRequest(crossedRequest.requestId);
      setAccepted(true);
    } catch (err) {
      setAcceptError(messageFor(err));
    } finally {
      setAccepting(false);
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

      {sent ? <Text className="mb-4 text-center text-green-600">Request sent</Text> : null}

      {crossedRequest !== null ? (
        <View className="mb-4">
          <Text className="mb-2 text-center text-black dark:text-white">
            {crossedRequest.email} already sent you a request
          </Text>
          {accepted ? (
            <Text className="text-center text-green-600">Request accepted</Text>
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                disabled={accepting}
                onPress={handleAccept}
                className={`items-center rounded-lg py-3 ${accepting ? 'bg-blue-200' : 'bg-blue-500'}`}
              >
                <Text className="text-base font-semibold text-white">Accept</Text>
              </Pressable>
              {acceptError !== null ? (
                <Text className="mt-2 text-center text-red-500">{acceptError}</Text>
              ) : null}
            </>
          )}
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        disabled={isSubmitDisabled}
        onPress={handleSubmit}
        className={`items-center rounded-lg py-3 ${isSubmitDisabled ? 'bg-blue-200' : 'bg-blue-500'}`}
      >
        <Text className="text-base font-semibold text-white">Send request</Text>
      </Pressable>
    </View>
  );
}
