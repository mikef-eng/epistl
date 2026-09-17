import { Ionicons } from '@expo/vector-icons';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useColorScheme } from 'nativewind';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  acceptContactRequest,
  ApiError,
  type Contact,
  type ContactRequestParty,
  declineContactRequest,
  listContactRequests,
  listContacts,
  removeContact,
} from '../api/client';
import type { MainTabParamList, RootStackParamList } from '../navigation/types';

/**
 * Real `Friends` tab (issue #127), replacing issue #94's placeholder and
 * retiring the former `ContactsScreen.tsx` it evolved from (their reuse of
 * `listContacts`/loading/error/refresh scaffolding and `hasFullKeyBundle`
 * gating/tap-to-open-chat behavior stays verbatim). Adds:
 * - a "Requests" section above "Friends" (pending incoming/outgoing contact
 *   requests, issue #79/#80's `GET /api/contacts/requests` and
 *   accept/decline endpoints), visible only when non-empty;
 * - a remove action per friend row (issue #126 part A's mutual
 *   `DELETE /api/contacts/{user_id}`), via long-press (no swipe-gesture
 *   dependency is in this app yet -- see AGENTS.md's "extra work becomes a
 *   new issue" guidance rather than adding one here).
 * See docs/superpowers/specs/2026-09-13-friends-conversations-ux-design.md,
 * "Friends screen, requests, and removal".
 */
type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, 'Friends'>,
  NativeStackScreenProps<RootStackParamList>
>;

interface RequestsState {
  incoming: ContactRequestParty[];
  outgoing: ContactRequestParty[];
}

const EMPTY_REQUESTS: RequestsState = { incoming: [], outgoing: [] };

function messageFor(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

/** A contact is only usable for chat once its full PQXDH key bundle
 * (issue #35) is present on the server. Each field is checked
 * independently rather than relying on the "all four or none" invariant
 * the server currently guarantees, so this stays correct even if that
 * invariant ever changes. */
function hasFullKeyBundle(contact: Contact): boolean {
  return (
    contact.x25519_public_key_b64 !== null &&
    contact.kyber_public_key_b64 !== null &&
    contact.dilithium_public_key_b64 !== null &&
    contact.prekey_signature_b64 !== null
  );
}

/** First letter of the contact's email, uppercased, for the row avatar
 * circle -- no photo upload/server-side avatar storage, just a derived
 * initial, matching `ConversationsScreen`'s `initialFor`. */
function initialFor(email: string): string {
  return email.trim().charAt(0).toUpperCase() || '?';
}

/** Removes a key from a `Record` map by producing a fresh object, used for
 * both the remove-friend and request-accept/decline inline error maps
 * below -- returns the same reference when the key is already absent, so
 * callers can use it unconditionally without triggering an extra render. */
function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) {
    return map;
  }
  const next = { ...map };
  delete next[key];
  return next;
}

export default function FriendsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  // Matches the header's existing `text-black dark:text-white` convention --
  // `Ionicons`' `color` prop can't take a NativeWind `className`.
  const headerIconColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [requests, setRequests] = useState<RequestsState>(EMPTY_REQUESTS);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({});
  const [requestActionIds, setRequestActionIds] = useState<Set<string>>(new Set());
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({});

  // Initial fetch on mount. The effect only reads the response of an
  // already-in-flight promise and updates state in `.then`/`.catch`/
  // `.finally` callbacks (never synchronously in the effect body itself),
  // so it relies on the initial state values above (loading = true,
  // error = null) rather than resetting them up front -- mirrors
  // `ConversationsScreen`'s two-source `Promise.all` pattern.
  useEffect(() => {
    let cancelled = false;
    Promise.all([listContacts(), listContactRequests()])
      .then(([contactsResponse, requestsResponse]) => {
        if (!cancelled) {
          setContacts(contactsResponse.contacts);
          setRequests(requestsResponse);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(messageFor(err));
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
  }, []);

  const refetch = useCallback(async (isRefresh: boolean) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const [contactsResponse, requestsResponse] = await Promise.all([
        listContacts(),
        listContactRequests(),
      ]);
      setContacts(contactsResponse.contacts);
      setRequests(requestsResponse);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      if (isRefresh) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }, []);

  // Refetch whenever this tab regains focus (e.g. the other party accepted
  // while we were on Conversations/AddContact), matching
  // `ConversationsScreen`. Without this, Friends stays on its mount-time
  // snapshot -- accept creates contacts server-side but this list looks
  // empty until a manual pull-to-refresh.
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      refetch(false);
    });
    return unsubscribe;
  }, [navigation, refetch]);

  function handleRefresh() {
    refetch(true);
  }

  function handleRetry() {
    refetch(false);
  }

  function handleAddContact() {
    navigation.navigate('AddContact');
  }

  function handleOpenSettings() {
    navigation.navigate('Settings');
  }

  function handleOpenChat(contact: Contact) {
    navigation.navigate('Chat', { userId: contact.user_id, email: contact.email });
  }

  /** Failure leaves `contacts` untouched and surfaces a per-row inline
   * error -- no optimistic removal that has to be rolled back, matching
   * `ChatScreen`'s existing failure-doesn't-mutate convention. */
  async function performRemove(contact: Contact) {
    setRemoveErrors((prev) => withoutKey(prev, contact.user_id));
    setRemovingIds((prev) => new Set(prev).add(contact.user_id));
    try {
      await removeContact(contact.user_id);
      setContacts((prev) => prev.filter((c) => c.user_id !== contact.user_id));
    } catch (err) {
      setRemoveErrors((prev) => ({ ...prev, [contact.user_id]: messageFor(err) }));
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(contact.user_id);
        return next;
      });
    }
  }

  /** Long-press context menu for the remove action (issue #127's "Coder's
   * choice" between swipe-to-delete and long-press -- swipe would need a
   * gesture-handler dependency this app doesn't have yet, so this uses
   * React Native's built-in `Alert` instead). */
  function handleLongPressFriend(contact: Contact) {
    if (removingIds.has(contact.user_id)) {
      // Already in flight for this row -- ignore a repeat long-press rather
      // than opening a second confirmation on top of it.
      return;
    }
    Alert.alert(contact.email, 'Remove this friend?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          performRemove(contact);
        },
      },
    ]);
  }

  async function handleAccept(request: ContactRequestParty) {
    setRequestErrors((prev) => withoutKey(prev, request.id));
    setRequestActionIds((prev) => new Set(prev).add(request.id));
    try {
      await acceptContactRequest(request.id);
      // Accept creates mutual `contacts` rows server-side; re-pull both
      // lists so the new friend appears here immediately instead of only
      // clearing the request and leaving "No contacts yet".
      const [contactsResponse, requestsResponse] = await Promise.all([
        listContacts(),
        listContactRequests(),
      ]);
      setContacts(contactsResponse.contacts);
      setRequests(requestsResponse);
    } catch (err) {
      setRequestErrors((prev) => ({ ...prev, [request.id]: messageFor(err) }));
    } finally {
      setRequestActionIds((prev) => {
        const next = new Set(prev);
        next.delete(request.id);
        return next;
      });
    }
  }

  async function handleDecline(request: ContactRequestParty) {
    setRequestErrors((prev) => withoutKey(prev, request.id));
    setRequestActionIds((prev) => new Set(prev).add(request.id));
    try {
      await declineContactRequest(request.id);
      setRequests((prev) => ({
        ...prev,
        incoming: prev.incoming.filter((r) => r.id !== request.id),
      }));
    } catch (err) {
      setRequestErrors((prev) => ({ ...prev, [request.id]: messageFor(err) }));
    } finally {
      setRequestActionIds((prev) => {
        const next = new Set(prev);
        next.delete(request.id);
        return next;
      });
    }
  }

  const hasRequests = requests.incoming.length > 0 || requests.outgoing.length > 0;

  return (
    <View testID="friends-screen" className="flex-1 bg-white dark:bg-black">
      <View
        style={{ paddingTop: insets.top }}
        className="flex-row items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700"
      >
        <Text className="text-lg font-semibold text-black dark:text-white">Friends</Text>
        <View className="flex-row items-center">
          <Pressable accessibilityRole="button" onPress={handleAddContact}>
            <Text className="text-base font-semibold text-[#8B2F4B]">Add contact</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={handleOpenSettings}
            className="ml-4"
          >
            <Ionicons name="settings-outline" size={24} color={headerIconColor} />
          </Pressable>
        </View>
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator testID="friends-loading" size="large" />
        </View>
      ) : error !== null ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="mb-4 text-center text-red-500">{error}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={handleRetry}
            className="rounded-lg bg-[#8B2F4B] px-4 py-2"
          >
            <Text className="text-base font-semibold text-white">Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={contacts}
          keyExtractor={(item) => item.user_id}
          contentContainerStyle={contacts.length === 0 && !hasRequests ? { flexGrow: 1 } : undefined}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          ListHeaderComponent={
            hasRequests ? (
              <View testID="requests-section" className="border-b border-gray-200 dark:border-gray-700">
                <Text className="px-4 pt-4 text-sm font-semibold text-gray-500 dark:text-gray-400">
                  Requests
                </Text>
                {requests.incoming.map((request) => (
                  <View
                    key={request.id}
                    testID={`request-incoming-${request.id}`}
                    className="px-4 py-3"
                  >
                    <View className="flex-row items-center justify-between">
                      <Text className="flex-1 pr-3 text-base text-black dark:text-white">
                        {request.email}
                      </Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Accept ${request.email}`}
                        disabled={requestActionIds.has(request.id)}
                        onPress={() => handleAccept(request)}
                        className="mr-2 rounded-lg bg-[#8B2F4B] px-3 py-1"
                      >
                        <Text className="text-sm font-semibold text-white">Accept</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Decline ${request.email}`}
                        disabled={requestActionIds.has(request.id)}
                        onPress={() => handleDecline(request)}
                        className="rounded-lg bg-gray-200 px-3 py-1 dark:bg-gray-700"
                      >
                        <Text className="text-sm font-semibold text-black dark:text-white">
                          Decline
                        </Text>
                      </Pressable>
                    </View>
                    {requestErrors[request.id] !== undefined ? (
                      <Text className="mt-1 text-sm text-red-500">
                        {requestErrors[request.id]}
                      </Text>
                    ) : null}
                  </View>
                ))}
                {requests.outgoing.map((request) => (
                  <View
                    key={request.id}
                    testID={`request-outgoing-${request.id}`}
                    className="flex-row items-center justify-between px-4 py-3"
                  >
                    <Text className="text-base text-black dark:text-white">{request.email}</Text>
                    <Text className="text-sm text-gray-400 dark:text-gray-500">Pending</Text>
                  </View>
                ))}
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View className="flex-1 items-center justify-center px-6 py-12">
              <Text className="mb-2 text-4xl">👥</Text>
              <Text className="text-center text-gray-500 dark:text-gray-400">No contacts yet</Text>
            </View>
          }
          renderItem={({ item }) => {
            const keysReady = hasFullKeyBundle(item);
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !keysReady }}
                disabled={!keysReady}
                onPress={() => {
                  if (keysReady) {
                    handleOpenChat(item);
                  }
                }}
                onLongPress={() => handleLongPressFriend(item)}
                className={`flex-row items-center border-b border-gray-100 px-4 py-4 dark:border-gray-800 ${keysReady ? '' : 'opacity-50'}`}
              >
                <View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-700">
                  <Text className="text-base font-semibold text-black dark:text-white">
                    {initialFor(item.email)}
                  </Text>
                </View>
                <View className="flex-1">
                  <Text className="text-base text-black dark:text-white">{item.email}</Text>
                  {keysReady ? null : (
                    <Text className="text-sm text-gray-400 dark:text-gray-500">
                      Waiting for {item.email} to finish setup
                    </Text>
                  )}
                  {removeErrors[item.user_id] !== undefined ? (
                    <Text className="mt-1 text-sm text-red-500">{removeErrors[item.user_id]}</Text>
                  ) : null}
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}
