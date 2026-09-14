import "./global.css";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { colorScheme } from "nativewind";
import { useEffect, useState } from "react";

import MainTabs from "./src/navigation/MainTabs";
import type { RootStackParamList } from "./src/navigation/types";
import AddContactScreen from "./src/screens/AddContactScreen";
import ChatScreen from "./src/screens/ChatScreen";
import LoginScreen from "./src/screens/LoginScreen";
import QuicSpikeScreen from "./src/screens/QuicSpikeScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import UserProfileScreen from "./src/screens/UserProfileScreen";
import { getThemePreference } from "./src/settings/preferences";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  // Gates the navigation tree's first render on the persisted theme
  // preference being read and applied via `colorScheme.set` first, so a
  // cold start never briefly flashes the wrong theme before switching to
  // the persisted one (issue #125).
  const [themeReady, setThemeReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getThemePreference().then((pref) => {
      if (cancelled) {
        return;
      }
      colorScheme.set(pref);
      setThemeReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!themeReady) {
    return null;
  }

  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Login">
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
        {/* Its own tab headers provide Conversations/Friends' titles and
            gear icons, so the root stack's default header is hidden here
            (issue #94). */}
        <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
        <Stack.Screen name="AddContact" component={AddContactScreen} />
        <Stack.Screen name="UserProfile" component={UserProfileScreen} />
        <Stack.Screen name="Chat" component={ChatScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
        {/* Dev-only (issue #67 spike) -- never part of the real,
            authenticated app flow; reachable only from LoginScreen's
            __DEV__-gated link below. */}
        {__DEV__ ? <Stack.Screen name="QuicSpike" component={QuicSpikeScreen} /> : null}
      </Stack.Navigator>
      <StatusBar style="auto" />
    </NavigationContainer>
  );
}
