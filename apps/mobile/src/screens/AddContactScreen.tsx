import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useColorScheme } from 'nativewind';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  acceptContactRequest,
  ApiError,
  IncomingRequestExistsError,
  searchUsers,
  sendContactRequest,
  type SearchUser,
} from '../api/client';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'AddContact'>;

/** Mirrors `apps/api/src/search.rs`'s `MIN_QUERY_LEN` (issue #99) so this
 * screen never fires a request the server would just turn around and
 * answer with an empty list -- duplicated rather than shared since the two
 * live in separate language runtimes/packages. */
const MIN_QUERY_LENGTH = 3;

/** How long to wait after the last keystroke before firing a search --
 * generous enough to avoid a request per keystroke from a fast typist,
 * short enough to still feel instant. Exact value is the Coder's choice
 * per issue #100's acceptance criteria. */
const SEARCH_DEBOUNCE_MS = 300;

/** Maps `POST /api/contacts/requests` (issue #79) error codes to
 * user-facing copy reflecting request semantics -- `incoming_request_exists`
 * is handled separately below since it carries a `request_id` and renders
 * an "Accept" prompt rather than a plain error message. */
const ERROR_MESSAGES: Record<string, string> = {
  user_not_found: 'No user with that username',
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
  username: string;
}

/** Removes a key from a `Record` by producing a fresh object -- mirrors
 * `FriendsScreen`'s `withoutKey`, used the same way here for the per-row
 * add-error map. */
function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) {
    return map;
  }
  const next = { ...map };
  delete next[key];
  return next;
}

/**
 * Discover-search flow (issue #100), replacing issue #84's single
 * exact-email "Send request" input with a search-as-you-type field wired
 * to issue #99's `GET /api/users/search`. Each result row keeps two
 * independent tap targets: an explicit "+" button that sends a contact
 * request directly (issue #84's `sendContactRequest`, unchanged in
 * behavior), and tapping the row itself navigates to `UserProfileScreen`
 * (issue #101, a separate follow-up) rather than sending anything. On the
 * crossed-request case (`409 incoming_request_exists`, issue #79) this
 * still shows the inline "Accept" prompt issue #150 added, now triggered
 * from a row's add button instead of a single freeform submit.
 * See `docs/superpowers/specs/2026-09-13-search-design.md`, "Discover
 * search", `AddContactScreen` paragraph.
 */
export default function AddContactScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  // Matches the header's existing `text-black dark:text-white` convention --
  // `Ionicons`' `color` prop can't take a NativeWind `className`.
  const headerIconColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [addingIds, setAddingIds] = useState<Set<string>>(new Set());
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [addErrors, setAddErrors] = useState<Record<string, string>>({});

  const [crossedRequest, setCrossedRequest] = useState<CrossedRequest | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  // Debounced search-as-you-type, wired to issue #99's
  // GET /api/users/search. Below MIN_QUERY_LENGTH, results are cleared
  // synchronously and no request is ever fired -- an empty/hidden list,
  // not an error state.
  useEffect(() => {
    if (query.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setSearchError(null);
      setRateLimited(false);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      searchUsers(query)
        .then((response) => {
          if (cancelled) {
            return;
          }
          setResults(response.users);
          setSearchError(null);
          setRateLimited(false);
        })
        .catch((err) => {
          if (cancelled) {
            return;
          }
          setResults([]);
          if (err instanceof ApiError && err.status === 429) {
            setRateLimited(true);
            setSearchError(null);
          } else {
            setRateLimited(false);
            setSearchError('Something went wrong');
          }
        })
        .finally(() => {
          if (!cancelled) {
            setSearching(false);
          }
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  function handleViewProfile(result: SearchUser) {
    navigation.navigate('UserProfile', {
      userId: result.user_id,
      username: result.username,
      email: result.email,
    });
  }

  /** Sends a contact request directly from a result row's "+" button --
   * distinct from `handleViewProfile` above, which never sends anything. */
  async function handleAdd(result: SearchUser) {
    if (addingIds.has(result.user_id)) {
      return;
    }

    setAddErrors((prev) => withoutKey(prev, result.user_id));
    setAddingIds((prev) => new Set(prev).add(result.user_id));
    setCrossedRequest(null);
    setAcceptError(null);
    setAccepted(false);
    try {
      await sendContactRequest({ username: result.username });
      setAddedIds((prev) => new Set(prev).add(result.user_id));
    } catch (err) {
      if (err instanceof IncomingRequestExistsError) {
        setCrossedRequest({ requestId: err.requestId, username: result.username });
      } else {
        setAddErrors((prev) => ({ ...prev, [result.user_id]: messageFor(err) }));
      }
    } finally {
      setAddingIds((prev) => {
        const next = new Set(prev);
        next.delete(result.user_id);
        return next;
      });
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
        <Text className="text-lg font-semibold text-black dark:text-white">Add contact</Text>
      </View>

      <View className="flex-1 px-6 pt-6">
      <TextInput
        className="mb-3 rounded-lg border border-gray-300 px-4 py-3 text-base text-black dark:border-gray-700 dark:text-white"
        placeholder="Search by email"
        placeholderTextColor="#9CA3AF"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        value={query}
        onChangeText={setQuery}
      />

      {rateLimited ? (
        <Text className="mb-4 text-center text-red-500">Try again in a moment</Text>
      ) : searchError !== null ? (
        <Text className="mb-4 text-center text-red-500">{searchError}</Text>
      ) : null}

      {crossedRequest !== null ? (
        <View className="mb-4">
          <Text className="mb-2 text-center text-black dark:text-white">
            {crossedRequest.username} already sent you a request
          </Text>
          {accepted ? (
            <Text className="text-center text-green-600">Request accepted</Text>
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                disabled={accepting}
                onPress={handleAccept}
                className={`items-center rounded-lg py-3 ${
                  accepting ? 'bg-[#8B2F4B]/35 dark:bg-[#8B2F4B]/25' : 'bg-[#8B2F4B] dark:bg-[#8B2F4B]'
                }`}
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

      {searching ? <ActivityIndicator testID="search-loading" /> : null}

      {results.map((result) => (
        <View
          key={result.user_id}
          testID={`search-result-${result.user_id}`}
          className="border-b border-gray-100 py-3 dark:border-gray-800"
        >
          <View className="flex-row items-center justify-between">
            <Pressable
              accessibilityRole="button"
              className="flex-1 pr-3"
              onPress={() => handleViewProfile(result)}
            >
              <Text className="text-base text-black dark:text-white">{result.username}</Text>
              <Text className="text-sm text-gray-500 dark:text-gray-400">{result.email}</Text>
            </Pressable>
            {addedIds.has(result.user_id) ? (
              <Text className="text-sm font-semibold text-green-600">Sent</Text>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Add ${result.username}`}
                disabled={addingIds.has(result.user_id)}
                onPress={() => handleAdd(result)}
                className={`rounded-full px-3 py-1 ${
                  addingIds.has(result.user_id)
                    ? 'bg-[#8B2F4B]/35 dark:bg-[#8B2F4B]/25'
                    : 'bg-[#8B2F4B] dark:bg-[#8B2F4B]'
                }`}
              >
                <Text className="text-base font-semibold text-white">+</Text>
              </Pressable>
            )}
          </View>
          {addErrors[result.user_id] !== undefined ? (
            <Text className="mt-1 text-sm text-red-500">{addErrors[result.user_id]}</Text>
          ) : null}
        </View>
      ))}
      </View>
    </View>
  );
}
