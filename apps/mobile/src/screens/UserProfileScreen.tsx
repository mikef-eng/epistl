import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useColorScheme } from 'nativewind';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  acceptContactRequest,
  ApiError,
  cancelContactRequest,
  type Contact,
  type ContactRequestsResponse,
  declineContactRequest,
  IncomingRequestExistsError,
  listContactRequests,
  listContacts,
  sendContactRequest,
} from '../api/client';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'UserProfile'>;

/** The four mutually-exclusive relationship states this screen renders
 * (issue #101's acceptance criteria), derived on mount from `GET
 * /api/contacts` + `GET /api/contacts/requests` (issue #79) rather than
 * carried in navigation params, since the caller (`AddContactScreen`'s
 * search results, issue #100) has no relationship info to pass -- see
 * `SearchUser`'s module doc in `../api/client`. */
type Relationship =
  | { kind: 'none' }
  | { kind: 'outgoing'; requestId: string }
  | { kind: 'incoming'; requestId: string }
  | { kind: 'friends' };

/** Maps `POST /api/contacts/requests` error codes to user-facing copy for
 * the "Add friend" action -- duplicated from `AddContactScreen`'s
 * `ERROR_MESSAGES` rather than shared, same convention as that screen's
 * `withoutKey` duplication note. */
const ADD_ERROR_MESSAGES: Record<string, string> = {
  user_not_found: 'No user with that email',
  already_pending: 'You already sent this person a request',
  already_contact: 'Already in your contacts',
  cannot_add_self: "You can't add yourself",
};

function messageForAdd(err: unknown): string {
  if (err instanceof ApiError) {
    return ADD_ERROR_MESSAGES[err.code] ?? 'Something went wrong';
  }
  return 'Something went wrong';
}

/** For cancel/accept/decline, mirrors `FriendsScreen`'s `messageFor`
 * verbatim (surfaces the backend's error code directly as the message --
 * these actions only ever fail on a handful of not-found/forbidden races,
 * not on the richer validation `sendContactRequest` above needs). */
function messageFor(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

/** Pure derivation from the two lists `GET /api/contacts` and `GET
 * /api/contacts/requests` return into this screen's single `Relationship`.
 * Kept side-effect-free (no `setState`) and separate from the mount effect/
 * retry handler below so both can call it directly inside a `.then()`
 * without tripping the "setState synchronously in an effect" lint rule --
 * `deriveRelationship` itself never calls `setState`, only its callers do. */
function deriveRelationship(
  contacts: Contact[],
  requests: ContactRequestsResponse,
  userId: string
): Relationship {
  if (contacts.some((c) => c.user_id === userId)) {
    return { kind: 'friends' };
  }
  const incoming = requests.incoming.find((r) => r.user_id === userId);
  if (incoming !== undefined) {
    return { kind: 'incoming', requestId: incoming.id };
  }
  const outgoing = requests.outgoing.find((r) => r.user_id === userId);
  if (outgoing !== undefined) {
    return { kind: 'outgoing', requestId: outgoing.id };
  }
  return { kind: 'none' };
}

/**
 * Relationship-status-aware profile screen (issue #101), reached only from
 * `AddContactScreen`'s search results (issue #100) by tapping a result row.
 * Renders exactly one of four states -- unconnected, outgoing pending,
 * incoming pending, already friends -- and every action reuses the
 * mutual-contacts sub-project's existing endpoints/error handling verbatim
 * (issues #79, #80, #83); no new relationship-mutation logic lives here.
 * Removal is deliberately absent (stays `FriendsScreen`-only, issue #126).
 * See `docs/superpowers/specs/2026-09-13-search-design.md`, "Discover
 * search", `UserProfileScreen` paragraph.
 */
export default function UserProfileScreen({ navigation, route }: Props) {
  const { userId, email } = route.params;
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  // Matches the header's existing `text-black dark:text-white` convention --
  // `Ionicons`' `color` prop can't take a NativeWind `className`.
  const headerIconColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';

  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Initial fetch on mount, combining `GET /api/contacts` and `GET
  // /api/contacts/requests` (issue #79) via `deriveRelationship` above --
  // mirrors `FriendsScreen`'s two-source `Promise.all` mount effect
  // verbatim, including relying on the initial state values above (loading
  // = true, loadError = null) rather than resetting them synchronously in
  // the effect body itself.
  useEffect(() => {
    let cancelled = false;
    Promise.all([listContacts(), listContactRequests()])
      .then(([contactsResponse, requestsResponse]) => {
        if (!cancelled) {
          setRelationship(deriveRelationship(contactsResponse.contacts, requestsResponse, userId));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(messageFor(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  /** Retries the initial fetch -- a plain event handler (not an effect
   * body), so it's fine to set `loading`/`loadError` synchronously before
   * awaiting, unlike the mount effect above. Mirrors `FriendsScreen`'s
   * `handleRetry`/`refetch` split. */
  async function handleRetryLoad() {
    setLoading(true);
    setLoadError(null);
    try {
      const [contactsResponse, requestsResponse] = await Promise.all([
        listContacts(),
        listContactRequests(),
      ]);
      setRelationship(deriveRelationship(contactsResponse.contacts, requestsResponse, userId));
    } catch (err) {
      setLoadError(messageFor(err));
    } finally {
      setLoading(false);
    }
  }

  /** Unconnected -> outgoing pending. On the crossed-request case (`409
   * incoming_request_exists`, issue #79 -- they already requested the
   * caller between this screen's initial fetch and this tap) flips
   * straight to the incoming-pending state using the carried request id,
   * same as `AddContactScreen`'s accept prompt, rather than showing a
   * dead-end error for a state this screen already knows how to render. */
  async function handleAdd() {
    if (actionPending) {
      return;
    }
    setActionError(null);
    setActionPending(true);
    try {
      const created = await sendContactRequest(email);
      setRelationship({ kind: 'outgoing', requestId: created.id });
    } catch (err) {
      if (err instanceof IncomingRequestExistsError) {
        setRelationship({ kind: 'incoming', requestId: err.requestId });
      } else {
        setActionError(messageForAdd(err));
      }
    } finally {
      setActionPending(false);
    }
  }

  /** Outgoing pending -> unconnected. Failure leaves the outgoing-pending
   * state in place with an inline error, matching `FriendsScreen`'s
   * failure-doesn't-mutate convention. */
  async function handleCancel(requestId: string) {
    if (actionPending) {
      return;
    }
    setActionError(null);
    setActionPending(true);
    try {
      await cancelContactRequest(requestId);
      setRelationship({ kind: 'none' });
    } catch (err) {
      setActionError(messageFor(err));
    } finally {
      setActionPending(false);
    }
  }

  /** Incoming pending -> friends. */
  async function handleAccept(requestId: string) {
    if (actionPending) {
      return;
    }
    setActionError(null);
    setActionPending(true);
    try {
      await acceptContactRequest(requestId);
      setRelationship({ kind: 'friends' });
    } catch (err) {
      setActionError(messageFor(err));
    } finally {
      setActionPending(false);
    }
  }

  /** Incoming pending -> unconnected. */
  async function handleDecline(requestId: string) {
    if (actionPending) {
      return;
    }
    setActionError(null);
    setActionPending(true);
    try {
      await declineContactRequest(requestId);
      setRelationship({ kind: 'none' });
    } catch (err) {
      setActionError(messageFor(err));
    } finally {
      setActionPending(false);
    }
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
        <Text className="text-lg font-semibold text-black dark:text-white">{email}</Text>
      </View>

      <View className="flex-1 px-6 pt-6">
      {loading ? (
        <ActivityIndicator testID="profile-loading" />
      ) : loadError !== null ? (
        <View>
          <Text className="mb-4 text-center text-red-500">{loadError}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={handleRetryLoad}
            className="items-center rounded-lg bg-[#8B2F4B] py-3"
          >
            <Text className="text-base font-semibold text-white">Retry</Text>
          </Pressable>
        </View>
      ) : relationship !== null ? (
        <View testID={`profile-relationship-${relationship.kind}`}>
          {relationship.kind === 'none' ? (
            <Pressable
              accessibilityRole="button"
              disabled={actionPending}
              onPress={handleAdd}
              className={`items-center rounded-lg py-3 ${
                actionPending ? 'bg-[#8B2F4B]/35 dark:bg-[#8B2F4B]/25' : 'bg-[#8B2F4B] dark:bg-[#8B2F4B]'
              }`}
            >
              <Text className="text-base font-semibold text-white">Add friend</Text>
            </Pressable>
          ) : relationship.kind === 'outgoing' ? (
            <View>
              <Text className="mb-3 text-center text-gray-500 dark:text-gray-400">
                Request pending
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={actionPending}
                onPress={() => handleCancel(relationship.requestId)}
                className="items-center rounded-lg bg-gray-200 py-3 dark:bg-gray-700"
              >
                <Text className="text-base font-semibold text-black dark:text-white">Cancel</Text>
              </Pressable>
            </View>
          ) : relationship.kind === 'incoming' ? (
            <View>
              <Pressable
                accessibilityRole="button"
                disabled={actionPending}
                onPress={() => handleAccept(relationship.requestId)}
                className={`mb-3 items-center rounded-lg py-3 ${
                  actionPending ? 'bg-[#8B2F4B]/35 dark:bg-[#8B2F4B]/25' : 'bg-[#8B2F4B] dark:bg-[#8B2F4B]'
                }`}
              >
                <Text className="text-base font-semibold text-white">Accept</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={actionPending}
                onPress={() => handleDecline(relationship.requestId)}
                className="items-center rounded-lg bg-gray-200 py-3 dark:bg-gray-700"
              >
                <Text className="text-base font-semibold text-black dark:text-white">
                  Decline
                </Text>
              </Pressable>
            </View>
          ) : (
            <Text className="text-center text-gray-500 dark:text-gray-400">Friends</Text>
          )}
          {actionError !== null ? (
            <Text className="mt-3 text-center text-red-500">{actionError}</Text>
          ) : null}
        </View>
      ) : null}
      </View>
    </View>
  );
}
