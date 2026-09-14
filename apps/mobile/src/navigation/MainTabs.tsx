import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import ConversationsScreen from '../screens/ConversationsScreen';
import FriendsScreen from '../screens/FriendsScreen';
import type { MainTabParamList } from './types';

const Tab = createBottomTabNavigator<MainTabParamList>();

/**
 * The post-login landing route (`RootStackParamList`'s `Main`, issue #94).
 * Each tab draws its own header (title + gear icon to `Settings`) in its
 * body, matching this app's existing screens' convention (`ContactsScreen`,
 * `SettingsScreen`) rather than the native tab header, so the native stack
 * header for the `Main` route itself is hidden in `App.tsx`.
 */
export default function MainTabs() {
  return (
    <Tab.Navigator screenOptions={{ headerShown: false }}>
      <Tab.Screen name="Conversations" component={ConversationsScreen} />
      <Tab.Screen name="Friends" component={FriendsScreen} />
    </Tab.Navigator>
  );
}
