import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';

import { ApiError, listContacts, type Contact } from '../api/client';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Contacts'>;

function messageFor(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

export default function ContactsScreen({ navigation }: Props) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial fetch on mount. The effect only reads the response of an
  // already-in-flight promise and updates state in `.then`/`.catch`/
  // `.finally` callbacks (never synchronously in the effect body itself),
  // so it relies on the initial state values above (loading = true,
  // error = null) rather than resetting them up front.
  useEffect(() => {
    let cancelled = false;
    listContacts()
      .then((data) => {
        if (!cancelled) {
          setContacts(data.contacts);
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

  async function refetch(isRefresh: boolean) {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const data = await listContacts();
      setContacts(data.contacts);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      if (isRefresh) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }

  function handleRefresh() {
    refetch(true);
  }

  function handleRetry() {
    refetch(false);
  }

  function handleAddContact() {
    navigation.navigate('AddContact');
  }

  function handleOpenChat(contact: Contact) {
    navigation.navigate('Chat', { userId: contact.user_id, email: contact.email });
  }

  return (
    <View className="flex-1 bg-white">
      <View className="flex-row items-center justify-between border-b border-gray-200 px-4 py-3">
        <Text className="text-lg font-semibold">Contacts</Text>
        <Pressable accessibilityRole="button" onPress={handleAddContact}>
          <Text className="text-base font-semibold text-blue-500">Add contact</Text>
        </Pressable>
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator testID="contacts-loading" size="large" />
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
          data={contacts}
          keyExtractor={(item) => item.user_id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          ListEmptyComponent={
            <View className="flex-1 items-center justify-center px-6 py-12">
              <Text className="text-center text-gray-500">No contacts yet</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => handleOpenChat(item)}
              className="border-b border-gray-100 px-4 py-4"
            >
              <Text className="text-base">{item.email}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}
