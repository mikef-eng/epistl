import { act, render, screen, userEvent, waitFor } from '@testing-library/react-native';

import ConversationsScreen from '../src/screens/ConversationsScreen';
import { listContacts } from '../src/api/client';
import { getConversationSummaries, searchMessages } from '../src/storage/messages';

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
  };
});

jest.mock('../src/storage/messages', () => ({
  getConversationSummaries: jest.fn(),
  searchMessages: jest.fn(),
}));

const mockedListContacts = listContacts as jest.Mock;
const mockedGetConversationSummaries = getConversationSummaries as jest.Mock;
const mockedSearchMessages = searchMessages as jest.Mock;

// CI runs each test file in its own worker process, and this file's first
// render pays the one-time cost of registering RN/Reanimated native-module
// mocks in that worker. That cold start intermittently exceeds Jest's
// default 5000ms per-test timeout under CI load (observed in issue #26)
// even though the underlying behavior is correct and passes reliably
// locally. Give this file's tests more headroom rather than chase a
// non-existent app bug -- mirrors `FriendsScreen.test.tsx`.
jest.setTimeout(15000);

function contact(overrides: { user_id: string; email: string }) {
  return {
    added_at: '2024-01-01T00:00:00Z',
    x25519_public_key_b64: 'x25519-b64',
    kyber_public_key_b64: 'kyber-b64',
    dilithium_public_key_b64: 'dilithium-b64',
    prekey_signature_b64: 'sig-b64',
    ...overrides,
  };
}

function summary(overrides: {
  contactUserId: string;
  lastBody?: string;
  lastDirection?: 'incoming' | 'outgoing';
  lastCreatedAt?: string;
  hasUnread?: boolean;
}) {
  return {
    lastBody: 'hello there',
    lastDirection: 'incoming' as const,
    lastCreatedAt: '2024-01-01T00:00:00Z',
    hasUnread: false,
    ...overrides,
  };
}

function makeNavigation() {
  return {
    navigate: jest.fn(),
    addListener: jest.fn((_event: string, _handler: () => void) => jest.fn()),
  };
}

async function renderConversationsScreen(navigation = makeNavigation()) {
  const user = userEvent.setup();
  await render(<ConversationsScreen navigation={navigation as never} route={{} as never} />);
  return { navigation, user };
}

describe('ConversationsScreen', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('shows a loading indicator while the initial fetch is in flight', async () => {
    let resolveContacts!: (value: { contacts: never[] }) => void;
    mockedListContacts.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveContacts = resolve;
      })
    );
    mockedGetConversationSummaries.mockResolvedValueOnce([]);

    await renderConversationsScreen();

    expect(screen.getByTestId('conversations-loading')).toBeTruthy();

    resolveContacts({ contacts: [] });
    await waitFor(() => {
      expect(screen.queryByTestId('conversations-loading')).toBeNull();
    });
  });

  it('shows a "No conversations yet" message when there are no summaries', async () => {
    mockedGetConversationSummaries.mockResolvedValueOnce([]);
    mockedListContacts.mockResolvedValueOnce({ contacts: [] });

    await renderConversationsScreen();

    await waitFor(() => {
      expect(screen.getByText('No conversations yet')).toBeTruthy();
    });
  });

  it('renders dark: variants on its background, header, and empty-state text', async () => {
    mockedGetConversationSummaries.mockResolvedValueOnce([]);
    mockedListContacts.mockResolvedValueOnce({ contacts: [] });

    await renderConversationsScreen();

    await waitFor(() => {
      expect(screen.getByText('No conversations yet')).toBeTruthy();
    });

    expect(screen.getByText('Conversations').props.className).toContain('dark:text-white');
    expect(screen.getByText('No conversations yet').props.className).toContain(
      'dark:text-gray-400'
    );
  });

  it('merges summaries with contacts by contact_user_id, omitting a contact with no message history', async () => {
    mockedGetConversationSummaries.mockResolvedValueOnce([
      summary({ contactUserId: 'u1', lastBody: 'hi alice' }),
    ]);
    mockedListContacts.mockResolvedValueOnce({
      contacts: [
        contact({ user_id: 'u1', email: 'alice@example.com' }),
        contact({ user_id: 'u2', email: 'bob@example.com' }),
      ],
    });

    await renderConversationsScreen();

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });
    expect(screen.queryByText('bob@example.com')).toBeNull();
  });

  it('omits a summary whose contact is no longer present', async () => {
    mockedGetConversationSummaries.mockResolvedValueOnce([
      summary({ contactUserId: 'u1', lastBody: 'hi alice' }),
      summary({ contactUserId: 'ghost', lastBody: 'orphaned' }),
    ]);
    mockedListContacts.mockResolvedValueOnce({
      contacts: [contact({ user_id: 'u1', email: 'alice@example.com' })],
    });

    await renderConversationsScreen();

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });
    expect(screen.queryByText('orphaned')).toBeNull();
  });

  it('shows the truncated last-message preview for a row', async () => {
    mockedGetConversationSummaries.mockResolvedValueOnce([
      summary({ contactUserId: 'u1', lastBody: 'see you soon' }),
    ]);
    mockedListContacts.mockResolvedValueOnce({
      contacts: [contact({ user_id: 'u1', email: 'alice@example.com' })],
    });

    await renderConversationsScreen();

    await waitFor(() => {
      expect(screen.getByText('see you soon')).toBeTruthy();
    });
  });

  it('shows unread styling (bold email + dot) when hasUnread is true', async () => {
    mockedGetConversationSummaries.mockResolvedValueOnce([
      summary({ contactUserId: 'u1', hasUnread: true }),
    ]);
    mockedListContacts.mockResolvedValueOnce({
      contacts: [contact({ user_id: 'u1', email: 'alice@example.com' })],
    });

    await renderConversationsScreen();

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });

    expect(screen.getByText('alice@example.com').props.className).toContain('font-bold');
    expect(screen.getByTestId('conversation-unread-dot-u1')).toBeTruthy();
  });

  it('does not show unread styling when hasUnread is false', async () => {
    mockedGetConversationSummaries.mockResolvedValueOnce([
      summary({ contactUserId: 'u1', hasUnread: false }),
    ]);
    mockedListContacts.mockResolvedValueOnce({
      contacts: [contact({ user_id: 'u1', email: 'alice@example.com' })],
    });

    await renderConversationsScreen();

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });

    expect(screen.getByText('alice@example.com').props.className).not.toContain('font-bold');
    expect(screen.queryByTestId('conversation-unread-dot-u1')).toBeNull();
  });

  it('navigates to Chat with the contact userId and email when a row is tapped', async () => {
    mockedGetConversationSummaries.mockResolvedValueOnce([summary({ contactUserId: 'u1' })]);
    mockedListContacts.mockResolvedValueOnce({
      contacts: [contact({ user_id: 'u1', email: 'alice@example.com' })],
    });
    const { navigation, user } = await renderConversationsScreen();

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });

    await user.press(screen.getByText('alice@example.com'));

    expect(navigation.navigate).toHaveBeenCalledWith('Chat', {
      userId: 'u1',
      email: 'alice@example.com',
    });
  });

  it('navigates to Settings when the gear icon is pressed', async () => {
    mockedGetConversationSummaries.mockResolvedValueOnce([]);
    mockedListContacts.mockResolvedValueOnce({ contacts: [] });
    const { navigation, user } = await renderConversationsScreen();

    await waitFor(() => {
      expect(screen.getByText('No conversations yet')).toBeTruthy();
    });

    await user.press(screen.getByRole('button', { name: 'Settings' }));

    expect(navigation.navigate).toHaveBeenCalledWith('Settings');
  });

  it('shows an error message with a retry control that re-fetches', async () => {
    const { ApiError } = jest.requireMock('../src/api/client');
    mockedGetConversationSummaries.mockResolvedValueOnce([]);
    mockedListContacts.mockRejectedValueOnce(new ApiError('network_error', 0));
    const { user } = await renderConversationsScreen();

    await waitFor(() => {
      expect(screen.getByText('network_error')).toBeTruthy();
    });

    mockedGetConversationSummaries.mockResolvedValueOnce([summary({ contactUserId: 'u1' })]);
    mockedListContacts.mockResolvedValueOnce({
      contacts: [contact({ user_id: 'u1', email: 'alice@example.com' })],
    });
    await user.press(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });
  });

  it('refetches when the screen regains focus', async () => {
    mockedGetConversationSummaries.mockResolvedValueOnce([]);
    mockedListContacts.mockResolvedValueOnce({ contacts: [] });
    const navigation = makeNavigation();
    await renderConversationsScreen(navigation);

    await waitFor(() => {
      expect(screen.getByText('No conversations yet')).toBeTruthy();
    });
    expect(mockedListContacts).toHaveBeenCalledTimes(1);

    const focusCall = navigation.addListener.mock.calls.find(([event]) => event === 'focus');
    expect(focusCall).toBeTruthy();
    const focusHandler = focusCall![1] as () => void;

    mockedGetConversationSummaries.mockResolvedValueOnce([summary({ contactUserId: 'u1' })]);
    mockedListContacts.mockResolvedValueOnce({
      contacts: [contact({ user_id: 'u1', email: 'alice@example.com' })],
    });

    await act(async () => {
      focusHandler();
    });

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });
    expect(mockedListContacts).toHaveBeenCalledTimes(2);
  });

  describe('search', () => {
    beforeEach(() => {
      mockedGetConversationSummaries.mockResolvedValueOnce([
        summary({ contactUserId: 'u1', lastBody: 'hi alice' }),
        summary({ contactUserId: 'u2', lastBody: 'lunch tomorrow?' }),
      ]);
      mockedListContacts.mockResolvedValueOnce({
        contacts: [
          contact({ user_id: 'u1', email: 'alice@example.com' }),
          contact({ user_id: 'u2', email: 'bob@example.com' }),
        ],
      });
    });

    it('shows the full, unfiltered conversation list for an empty query', async () => {
      mockedSearchMessages.mockResolvedValue([]);
      const { user } = await renderConversationsScreen();

      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeTruthy();
        expect(screen.getByText('bob@example.com')).toBeTruthy();
      });

      expect(mockedSearchMessages).not.toHaveBeenCalled();

      await user.type(screen.getByTestId('conversations-search-input'), 'x');
      await user.clear(screen.getByTestId('conversations-search-input'));

      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeTruthy();
        expect(screen.getByText('bob@example.com')).toBeTruthy();
      });
    });

    it('includes a conversation matching only by contact email substring', async () => {
      mockedSearchMessages.mockResolvedValue([]);
      const { user } = await renderConversationsScreen();

      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeTruthy();
      });

      await user.type(screen.getByTestId('conversations-search-input'), 'alice');

      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeTruthy();
      });
      expect(screen.queryByText('bob@example.com')).toBeNull();
    });

    it('includes a conversation matching only by message content (searchMessages)', async () => {
      mockedSearchMessages.mockResolvedValue([{ contactUserId: 'u2' }]);
      const { user } = await renderConversationsScreen();

      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeTruthy();
      });

      await user.type(screen.getByTestId('conversations-search-input'), 'lunch');

      await waitFor(() => {
        expect(screen.getByText('bob@example.com')).toBeTruthy();
      });
      expect(screen.queryByText('alice@example.com')).toBeNull();
      expect(mockedSearchMessages).toHaveBeenCalledWith('lunch');
    });

    it('does not duplicate a conversation matching both email and message content', async () => {
      mockedSearchMessages.mockResolvedValue([{ contactUserId: 'u1' }]);
      const { user } = await renderConversationsScreen();

      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeTruthy();
      });

      await user.type(screen.getByTestId('conversations-search-input'), 'alice');

      await waitFor(() => {
        expect(screen.getAllByText('alice@example.com')).toHaveLength(1);
      });
      expect(screen.queryByText('bob@example.com')).toBeNull();
    });
  });
});
