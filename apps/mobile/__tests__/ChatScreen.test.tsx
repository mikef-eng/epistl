import { act, render, screen, userEvent, waitFor } from '@testing-library/react-native';

import { getToken } from '../src/api/session';
import { createChatSocket } from '../src/api/ws';
import ChatScreen from '../src/screens/ChatScreen';
import { getMessages, saveMessage } from '../src/storage/messages';

jest.mock('../src/api/ws', () => ({
  createChatSocket: jest.fn(),
}));

jest.mock('../src/api/session', () => ({
  getToken: jest.fn(),
}));

jest.mock('../src/storage/messages', () => ({
  getMessages: jest.fn(),
  saveMessage: jest.fn(),
}));

const mockedCreateChatSocket = createChatSocket as jest.Mock;
const mockedGetToken = getToken as jest.Mock;
const mockedGetMessages = getMessages as jest.Mock;
const mockedSaveMessage = saveMessage as jest.Mock;

// See ContactsScreen.test.tsx (issue #26) for why this file needs more
// headroom than Jest's default 5000ms per-test timeout under CI load.
jest.setTimeout(15000);

interface MockSocket {
  send: jest.Mock;
  close: jest.Mock;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

function createMockSocket(): MockSocket {
  return {
    send: jest.fn(),
    close: jest.fn(),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

const ROUTE = { params: { userId: 'contact-1', email: 'alice@example.com' } };

async function renderChatScreen(socket: MockSocket = createMockSocket()) {
  mockedCreateChatSocket.mockReturnValue(socket);
  const navigation = { navigate: jest.fn() };
  const view = await render(<ChatScreen navigation={navigation as never} route={ROUTE as never} />);
  const user = userEvent.setup();
  await waitFor(() => expect(mockedGetMessages).toHaveBeenCalledWith('contact-1'));
  await waitFor(() => expect(mockedCreateChatSocket).toHaveBeenCalledWith('token-123'));
  return { navigation, user, socket, unmount: view.unmount };
}

describe('ChatScreen', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetToken.mockResolvedValue('token-123');
    mockedGetMessages.mockResolvedValue([]);
    mockedSaveMessage.mockResolvedValue(undefined);
  });

  it('loads existing history on mount and renders it', async () => {
    mockedGetMessages.mockResolvedValueOnce([
      {
        id: 1,
        contactUserId: 'contact-1',
        direction: 'outgoing',
        bodyB64: 'aGk=',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 2,
        contactUserId: 'contact-1',
        direction: 'incoming',
        bodyB64: 'aGVsbG8=',
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    ]);

    await renderChatScreen();

    await waitFor(() => {
      expect(screen.getByText('hi')).toBeTruthy();
      expect(screen.getByText('hello')).toBeTruthy();
    });
  });

  it('sends a message: appends it optimistically, persists it, and sends the expected WS frame', async () => {
    const { user, socket } = await renderChatScreen();

    await user.type(screen.getByPlaceholderText('Message'), 'hey there');
    await user.press(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('hey there')).toBeTruthy();
    });

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'send', to: 'contact-1', body_b64: 'aGV5IHRoZXJl' })
    );
    expect(mockedSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contactUserId: 'contact-1',
        direction: 'outgoing',
        bodyB64: 'aGV5IHRoZXJl',
      })
    );
  });

  it('appends and persists an incoming message frame', async () => {
    const { socket } = await renderChatScreen();

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'message', from: 'contact-1', body_b64: 'aGVsbG8=' }),
      });
    });

    await waitFor(() => {
      expect(screen.getByText('hello')).toBeTruthy();
    });
    expect(mockedSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contactUserId: 'contact-1',
        direction: 'incoming',
        bodyB64: 'aGVsbG8=',
      })
    );
  });

  it('shows an inline "not delivered" note on a recipient_offline error, without removing the message', async () => {
    const { user, socket } = await renderChatScreen();

    await user.type(screen.getByPlaceholderText('Message'), 'hi');
    await user.press(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('hi')).toBeTruthy();
    });

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'error', code: 'recipient_offline' }),
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Not delivered: contact is offline')).toBeTruthy();
    });
    expect(screen.getByText('hi')).toBeTruthy();
  });

  it('shows a Disconnected banner when the socket closes, with no reconnect attempt', async () => {
    const { socket } = await renderChatScreen();

    expect(screen.queryByTestId('disconnected-banner')).toBeNull();

    await act(async () => {
      socket.onclose?.();
    });

    await waitFor(() => {
      expect(screen.getByTestId('disconnected-banner')).toBeTruthy();
    });
    expect(mockedCreateChatSocket).toHaveBeenCalledTimes(1);
  });

  it('closes the WebSocket connection when the screen unmounts', async () => {
    const { socket, unmount } = await renderChatScreen();

    await unmount();

    expect(socket.close).toHaveBeenCalled();
  });
});
