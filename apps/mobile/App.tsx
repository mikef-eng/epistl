import "./global.css";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";

import type { RootStackParamList } from "./src/navigation/types";
import AddContactScreen from "./src/screens/AddContactScreen";
import ChatScreen from "./src/screens/ChatScreen";
import ContactsScreen from "./src/screens/ContactsScreen";
import LoginScreen from "./src/screens/LoginScreen";
import QuicSpikeScreen from "./src/screens/QuicSpikeScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Login">
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
        <Stack.Screen name="Contacts" component={ContactsScreen} />
        <Stack.Screen name="AddContact" component={AddContactScreen} />
        <Stack.Screen name="Chat" component={ChatScreen} />
        {/* Dev-only (issue #67 spike) -- never part of the real,
            authenticated app flow; reachable only from LoginScreen's
            __DEV__-gated link below. */}
        {__DEV__ ? <Stack.Screen name="QuicSpike" component={QuicSpikeScreen} /> : null}
      </Stack.Navigator>
      <StatusBar style="auto" />
    </NavigationContainer>
  );
}
