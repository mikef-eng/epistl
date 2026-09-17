import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { render, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { listContactRequests, listContacts } from '../src/api/client';
import MainTabs from '../src/navigation/MainTabs';
import { getConversationSummaries } from '../src/storage/messages';
import type { RootStackParamList } from '../src/navigation/types';

/** Jest has no native safe-area module; seed metrics so the provider
 * renders children immediately instead of waiting forever. */
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

// Integration test for issue #94's tab-navigator restructure: a real
// `NavigationContainer`/`Stack.Navigator` hosting the real `MainTabs`, with
// simple stand-in screens for `Chat`/`AddContact`/`Settings` (their own
// internals -- crypto, storage, settings persistence -- are exercised by
// their own screen test files, not duplicated here) so this file can focus
// on navigation composition: are `Main`'s two tabs both reachable, does each
// tab's gear icon reach `Settings`, and do `Chat`/`AddContact`/`Settings`
// arrive as a normal stack push over `Main` (not nested tab navigation)?
jest.mock('../src/api/client', () => {
  class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number) {
      super(code);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
    }
  }
  return {
    ApiError,
    listContacts: jest.fn(),
    listContactRequests: jest.fn(),
  };
});

// `ConversationsScreen` (issue #95) pulls in `storage/messages.ts`, which
// imports the real `expo-sqlite` -- mocked wholesale here (as
// `ChatScreen.test.tsx` already does) so this file stays focused on
// navigation composition rather than exercising real on-device storage.
jest.mock('../src/storage/messages', () => ({
  getConversationSummaries: jest.fn(),
}));

const mockedListContacts = listContacts as jest.Mock;
const mockedListContactRequests = listContactRequests as jest.Mock;
const mockedGetConversationSummaries = getConversationSummaries as jest.Mock;

jest.setTimeout(15000);

function ChatStub() {
  return <Text>Chat screen stub</Text>;
}
function AddContactStub() {
  return <Text>AddContact screen stub</Text>;
}
function SettingsStub() {
  return <Text>Settings screen stub</Text>;
}

const Stack = createNativeStackNavigator<RootStackParamList>();

async function renderMainStack() {
  const user = userEvent.setup();
  await render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <NavigationContainer>
        <Stack.Navigator initialRouteName="Main">
          <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
          <Stack.Screen name="AddContact" component={AddContactStub} />
          <Stack.Screen name="Chat" component={ChatStub} />
          <Stack.Screen name="Settings" component={SettingsStub} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
  return { user };
}

describe('Main tab navigator (issue #94)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedListContacts.mockResolvedValue({ contacts: [] });
    mockedListContactRequests.mockResolvedValue({ incoming: [], outgoing: [] });
    mockedGetConversationSummaries.mockResolvedValue([]);
  });

  it('renders Main with the Conversations tab active and the Friends tab reachable', async () => {
    const { user } = await renderMainStack();

    // Conversations is the first-defined tab, so its empty state is visible
    // once the initial (mocked) fetch resolves, without any tab press.
    await waitFor(() => {
      expect(
        within(screen.getByTestId('conversations-screen')).getByText('No conversations yet')
      ).toBeTruthy();
    });

    await user.press(screen.getAllByText('Friends')[0]);

    await waitFor(() => {
      expect(screen.getByTestId('friends-screen')).toBeTruthy();
    });
    await waitFor(() => {
      expect(within(screen.getByTestId('friends-screen')).getByText('No contacts yet')).toBeTruthy();
    });
  });

  it("navigates to Settings from the Conversations tab's gear icon", async () => {
    const { user } = await renderMainStack();

    const conversationsScreen = screen.getByTestId('conversations-screen');
    await user.press(within(conversationsScreen).getByRole('button', { name: 'Settings' }));

    await waitFor(() => {
      expect(screen.getByText('Settings screen stub')).toBeTruthy();
    });
  });

  it("navigates to Settings from the Friends tab's gear icon", async () => {
    const { user } = await renderMainStack();
    await user.press(screen.getAllByText('Friends')[0]);

    await waitFor(() => {
      expect(screen.getByTestId('friends-screen')).toBeTruthy();
    });

    const friendsScreen = screen.getByTestId('friends-screen');
    await user.press(within(friendsScreen).getByRole('button', { name: 'Settings' }));

    await waitFor(() => {
      expect(screen.getByText('Settings screen stub')).toBeTruthy();
    });
  });

  it('pushes AddContact over Main from the Friends tab', async () => {
    const { user } = await renderMainStack();
    await user.press(screen.getAllByText('Friends')[0]);

    await waitFor(() => {
      expect(screen.getByTestId('friends-screen')).toBeTruthy();
    });

    await user.press(screen.getByRole('button', { name: 'Add contact' }));

    await waitFor(() => {
      expect(screen.getByText('AddContact screen stub')).toBeTruthy();
    });
  });

  it('pushes Chat over Main from a tap on a fully-keyed friend in the Friends tab', async () => {
    mockedListContacts.mockResolvedValue({
      contacts: [
        {
          user_id: 'u1',
          email: 'alice@example.com',
          added_at: '2024-01-01T00:00:00Z',
          x25519_public_key_b64: 'x25519-b64',
          kyber_public_key_b64: 'kyber-b64',
          dilithium_public_key_b64: 'dilithium-b64',
          prekey_signature_b64: 'sig-b64',
        },
      ],
    });
    const { user } = await renderMainStack();
    await user.press(screen.getAllByText('Friends')[0]);

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });

    await user.press(screen.getByText('alice@example.com'));

    await waitFor(() => {
      expect(screen.getByText('Chat screen stub')).toBeTruthy();
    });
  });
});
