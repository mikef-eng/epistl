import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';

import { ApiError, listContacts, type Contact } from '../api/client';
import type { MainTabParamList, RootStackParamList } from '../navigation/types';
import { getConversationSummaries, type ConversationSummary } from '../storage/messages';

/**
 * Real `Conversations` tab, replacing issue #94's placeholder. Merges the
 * on-device `getConversationSummaries()` (issue #93, local SQLite -- per
 * docs/decisions/0001-message-content-never-in-postgres.md this list is
 * never derived from the server) with `listContacts()` (issue #35's server
 * contacts list, for display metadata like email) by `contact_user_id`. See
 * docs/superpowers/specs/2026-09-13-friends-conversations-ux-design.md,
 * "Conversations screen & data model".
 */
type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, 'Conversations'>,
  NativeStackScreenProps<RootStackParamList>
>;

/** One row of the merged Conversations list: a summary that has a matching
 * contact (see `mergeConversations` for why summaries without one are
 * dropped). */
interface ConversationRow {
  contactUserId: string;
  email: string;
  lastBody: string;
  lastCreatedAt: string;
  hasUnread: boolean;
}

const PREVIEW_MAX_LENGTH = 80;

function messageFor(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

/**
 * Joins `getConversationSummaries()` with `listContacts()` by
 * `contact_user_id`, in the summaries' order (already most-recent-first per
 * `getConversationSummaries`' `ORDER BY`). A contact with no message
 * history has no summary and so never appears here -- Conversations shows
 * conversations, not contacts. Conversely, a summary whose contact is no
 * longer in `listContacts()` (e.g. the contact was since removed) is
 * dropped too, since there is no email left to render for it.
 */
function mergeConversations(
  summaries: ConversationSummary[],
  contacts: Contact[]
): ConversationRow[] {
  const contactsById = new Map(contacts.map((contact) => [contact.user_id, contact]));
  const rows: ConversationRow[] = [];
  for (const summary of summaries) {
    const contact = contactsById.get(summary.contactUserId);
    if (!contact) {
      continue;
    }
    rows.push({
      contactUserId: summary.contactUserId,
      email: contact.email,
      lastBody: summary.lastBody,
      lastCreatedAt: summary.lastCreatedAt,
      hasUnread: summary.hasUnread,
    });
  }
  return rows;
}

/** Collapses whitespace (message bodies may contain newlines) and truncates
 * to `PREVIEW_MAX_LENGTH` characters for the row's last-message preview. */
function truncatePreview(body: string): string {
  const singleLine = body.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= PREVIEW_MAX_LENGTH) {
    return singleLine;
  }
  return `${singleLine.slice(0, PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
}

/** Coarse relative-time label for a row's last-message timestamp (no
 * date-formatting dependency in this app yet -- see AGENTS.md's "extra
 * work becomes a new issue" guidance rather than adding one here). Falls
 * back to a locale date string once a message is a week or older. */
function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  const diffMinutes = Math.floor(diffMs / (60 * 1000));
  if (diffMinutes < 1) {
    return 'now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays}d`;
  }
  return new Date(iso).toLocaleDateString();
}

export default function ConversationsScreen({ navigation }: Props) {
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial fetch on mount. The effect only reads the response of an
  // already-in-flight promise and updates state in `.then`/`.catch`/
  // `.finally` callbacks (never synchronously in the effect body itself),
  // so it relies on the initial state values above (loading = true,
  // error = null) rather than resetting them up front -- mirrors
  // `FriendsScreen`'s existing pattern.
  useEffect(() => {
    let cancelled = false;
    Promise.all([getConversationSummaries(), listContacts()])
      .then(([summaries, contactsResponse]) => {
        if (!cancelled) {
          setRows(mergeConversations(summaries, contactsResponse.contacts));
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
      const [summaries, contactsResponse] = await Promise.all([
        getConversationSummaries(),
        listContacts(),
      ]);
      setRows(mergeConversations(summaries, contactsResponse.contacts));
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

  // Refetch whenever this tab regains focus (e.g. returning from a Chat
  // screen that just recorded a new message), in addition to mount and
  // pull-to-refresh. `navigation` here is the same object React Navigation
  // would otherwise hand back from `useNavigation()`, so this uses the
  // prop directly rather than the `useFocusEffect` hook -- consistent with
  // this codebase's existing prop-based navigation usage.
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

  function handleOpenSettings() {
    navigation.navigate('Settings');
  }

  function handleOpenChat(row: ConversationRow) {
    navigation.navigate('Chat', { userId: row.contactUserId, email: row.email });
  }

  return (
    <View testID="conversations-screen" className="flex-1 bg-white dark:bg-black">
      <View className="flex-row items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <Text className="text-lg font-semibold text-black dark:text-white">Conversations</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Settings"
          onPress={handleOpenSettings}
        >
          <Text className="text-lg text-black dark:text-white">⚙</Text>
        </Pressable>
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator testID="conversations-loading" size="large" />
        </View>
      ) : error !== null ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="mb-4 text-center text-red-500">{error}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={handleRetry}
            className="rounded-lg bg-blue-500 px-4 py-2"
          >
            <Text className="text-base font-semibold text-white">Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.contactUserId}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          ListEmptyComponent={
            <View className="flex-1 items-center justify-center px-6 py-12">
              <Text className="text-center text-gray-500 dark:text-gray-400">
                No conversations yet
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => handleOpenChat(item)}
              className="flex-row items-center border-b border-gray-100 px-4 py-4 dark:border-gray-800"
            >
              <View className="flex-1 pr-3">
                <View className="flex-row items-center">
                  {item.hasUnread ? (
                    <View
                      testID={`conversation-unread-dot-${item.contactUserId}`}
                      className="mr-2 h-2 w-2 rounded-full bg-blue-500"
                    />
                  ) : null}
                  <Text
                    className={`text-base text-black dark:text-white ${
                      item.hasUnread ? 'font-bold' : 'font-normal'
                    }`}
                  >
                    {item.email}
                  </Text>
                </View>
                <Text
                  numberOfLines={1}
                  className={`text-sm ${
                    item.hasUnread
                      ? 'font-semibold text-black dark:text-white'
                      : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {truncatePreview(item.lastBody)}
                </Text>
              </View>
              <Text className="text-xs text-gray-400 dark:text-gray-500">
                {formatRelativeTime(item.lastCreatedAt)}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}
