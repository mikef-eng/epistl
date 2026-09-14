import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Pressable, Text, View } from 'react-native';

import type { MainTabParamList, RootStackParamList } from '../navigation/types';

/**
 * Placeholder for the `Conversations` tab (issue #94's tab-navigator
 * restructure). Fully replaced (not extended) by the real
 * `ConversationsScreen` in a follow-up issue -- see
 * docs/superpowers/specs/2026-09-13-friends-conversations-ux-design.md's
 * "Conversations screen & data model" section.
 */
type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, 'Conversations'>,
  NativeStackScreenProps<RootStackParamList>
>;

export default function ConversationsScreen({ navigation }: Props) {
  function handleOpenSettings() {
    navigation.navigate('Settings');
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

      <View className="flex-1 items-center justify-center px-6 py-12">
        <Text className="text-center text-gray-500 dark:text-gray-400">No conversations yet</Text>
      </View>
    </View>
  );
}
