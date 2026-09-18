import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useColorScheme } from 'nativewind';
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { startAppSession, stopAppSession } from '../inbox/appSession';
import ConversationsScreen from '../screens/ConversationsScreen';
import FriendsScreen from '../screens/FriendsScreen';
import type { MainTabParamList } from './types';

const Tab = createBottomTabNavigator<MainTabParamList>();

/** The one deliberate accent color (Part C of the frontend-polish spec,
 * `--seal`) -- used here for the active tab's label, matching Login's
 * primary button. */
const SEAL = '#8B2F4B';
/** Matches the label's existing `text-gray-500 dark:text-gray-400`
 * convention -- Tailwind's `gray-500`/`gray-400` hex values, since
 * `Ionicons`' `color` prop can't take a NativeWind `className`. */
const INACTIVE_LIGHT = '#6B7280';
const INACTIVE_DARK = '#9CA3AF';

/** `Ionicons` name pairs (filled/outline) per tab route, per the
 * frontend-polish spec's B3 finding. */
const TAB_ICONS: Record<
  keyof MainTabParamList,
  { focused: keyof typeof Ionicons.glyphMap; unfocused: keyof typeof Ionicons.glyphMap }
> = {
  Conversations: { focused: 'chatbubbles', unfocused: 'chatbubbles-outline' },
  Friends: { focused: 'people', unfocused: 'people-outline' },
};

/**
 * Custom themed tab bar (per the frontend-polish spec's B1 finding and
 * standing directive to prefer custom-built nav chrome over React
 * Navigation's own theming props): a plain `View` with `dark:` classes and
 * bottom safe-area-inset padding, matching
 * `ConversationsScreen`/`FriendsScreen`'s header convention, instead of
 * `tabBarStyle`/`tabBarActiveTintColor` bolted onto the default bar.
 */
function ThemedTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const inactiveColor = colorScheme === 'dark' ? INACTIVE_DARK : INACTIVE_LIGHT;

  return (
    <View
      style={{ paddingBottom: insets.bottom }}
      className="flex-row border-t border-gray-200 bg-white dark:border-gray-700 dark:bg-black"
    >
      {state.routes.map((route, index) => {
        const isFocused = state.index === index;
        const label = descriptors[route.key]?.options.title ?? route.name;
        const icons = TAB_ICONS[route.name as keyof MainTabParamList];
        const iconName = isFocused ? icons.focused : icons.unfocused;

        function handlePress() {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        }

        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}
            accessibilityLabel={label}
            onPress={handlePress}
            className="flex-1 items-center justify-center py-2"
          >
            <Ionicons name={iconName} size={26} color={isFocused ? SEAL : inactiveColor} />
            <Text
              style={isFocused ? { color: SEAL } : undefined}
              className={
                isFocused
                  ? 'mt-1 text-sm font-semibold'
                  : 'mt-1 text-sm font-normal text-gray-500 dark:text-gray-400'
              }
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The post-login landing route (`RootStackParamList`'s `Main`, issue #94).
 * Each tab draws its own header (title + gear icon to `Settings`) in its
 * body, matching this app's existing screens' convention (`ContactsScreen`,
 * `SettingsScreen`) rather than the native tab header, so the native stack
 * header for the `Main` route itself is hidden in `App.tsx`. The bottom tab
 * bar itself is `ThemedTabBar` above, not React Navigation's default chrome
 * (frontend-polish spec, B1).
 *
 * This is also where the transport connection + app-level inbox listener
 * are owned (issue #165's `../inbox/appSession.ts`): opened once on mount,
 * closed once on unmount -- see that module's doc comment for why this
 * component's mount/unmount lifecycle is the right place for that, instead
 * of `ChatScreen.tsx`'s former per-screen `connect`/`close`.
 */
export default function MainTabs() {
  useEffect(() => {
    startAppSession();
    return () => {
      stopAppSession();
    };
  }, []);

  return (
    <Tab.Navigator
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <ThemedTabBar {...props} />}
    >
      <Tab.Screen name="Conversations" component={ConversationsScreen} />
      <Tab.Screen name="Friends" component={FriendsScreen} />
    </Tab.Navigator>
  );
}
