import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';

import { ApiError, listContacts, type Contact } from '../api/client';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Contacts'>;

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

  function handleOpenSettings() {
    navigation.navigate('Settings');
  }

  function handleOpenChat(contact: Contact) {
    navigation.navigate('Chat', { userId: contact.user_id, email: contact.email });
  }

  return (
    <View className="flex-1 bg-white dark:bg-black">
      <View className="flex-row items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <Text className="text-lg font-semibold text-black dark:text-white">Contacts</Text>
        <View className="flex-row items-center">
          <Pressable accessibilityRole="button" onPress={handleAddContact}>
            <Text className="text-base font-semibold text-blue-500">Add contact</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={handleOpenSettings}
            className="ml-4"
          >
            <Text className="text-lg text-black dark:text-white">⚙</Text>
          </Pressable>
        </View>
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
                className={`border-b border-gray-100 px-4 py-4 dark:border-gray-800 ${keysReady ? '' : 'opacity-50'}`}
              >
                <Text className="text-base text-black dark:text-white">{item.email}</Text>
                {keysReady ? null : (
                  <Text className="text-sm text-gray-400 dark:text-gray-500">
                    Waiting for {item.email} to finish setup
                  </Text>
                )}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}
