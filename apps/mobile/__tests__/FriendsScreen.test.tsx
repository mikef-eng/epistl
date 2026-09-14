import { render, screen, userEvent, waitFor } from '@testing-library/react-native';

import FriendsScreen from '../src/screens/FriendsScreen';
import { listContacts } from '../src/api/client';

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

const mockedListContacts = listContacts as jest.Mock;

// CI runs each test file in its own worker process, and this file's first
// render pays the one-time cost of registering RN/Reanimated native-module
// mocks in that worker. That cold start intermittently exceeds Jest's
// default 5000ms per-test timeout under CI load (observed in issue #26)
// even though the underlying behavior is correct and passes reliably
// locally. Give this file's tests more headroom rather than chase a
// non-existent app bug.
jest.setTimeout(15000);

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderFriendsScreen() {
  const navigation = { navigate: jest.fn() };
  const user = userEvent.setup();
  await render(<FriendsScreen navigation={navigation as never} route={{} as never} />);
  return { navigation, user };
}

function fullyKeyedContact(overrides: {
  user_id: string;
  email: string;
  added_at?: string;
}) {
  return {
    added_at: '2024-01-01T00:00:00Z',
    x25519_public_key_b64: 'x25519-b64',
    kyber_public_key_b64: 'kyber-b64',
    dilithium_public_key_b64: 'dilithium-b64',
    prekey_signature_b64: 'sig-b64',
    ...overrides,
  };
}

function unkeyedContact(overrides: { user_id: string; email: string; added_at?: string }) {
  return {
    added_at: '2024-01-01T00:00:00Z',
    x25519_public_key_b64: null,
    kyber_public_key_b64: null,
    dilithium_public_key_b64: null,
    prekey_signature_b64: null,
    ...overrides,
  };
}

describe('FriendsScreen', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('shows a loading indicator while the initial fetch is in flight', async () => {
    const deferred = makeDeferred<{ contacts: never[] }>();
    mockedListContacts.mockReturnValueOnce(deferred.promise);

    await renderFriendsScreen();

    expect(screen.getByTestId('friends-loading')).toBeTruthy();

    deferred.resolve({ contacts: [] });
    await waitFor(() => {
      expect(screen.queryByTestId('friends-loading')).toBeNull();
    });
  });

  it('renders each contact email once loaded', async () => {
    mockedListContacts.mockResolvedValueOnce({
      contacts: [
        fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' }),
        fullyKeyedContact({ user_id: 'u2', email: 'bob@example.com', added_at: '2024-01-02T00:00:00Z' }),
      ],
    });

    await renderFriendsScreen();

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
      expect(screen.getByText('bob@example.com')).toBeTruthy();
    });
  });

  it('shows a "No contacts yet" message when the list is empty', async () => {
    mockedListContacts.mockResolvedValueOnce({ contacts: [] });

    await renderFriendsScreen();

    await waitFor(() => {
      expect(screen.getByText('No contacts yet')).toBeTruthy();
    });
  });

  it('shows an error message with a retry control that re-calls listContacts', async () => {
    const { ApiError } = jest.requireMock('../src/api/client');
    mockedListContacts.mockRejectedValueOnce(new ApiError('network_error', 0));
    const { user } = await renderFriendsScreen();

    await waitFor(() => {
      expect(screen.getByText('network_error')).toBeTruthy();
    });
    expect(mockedListContacts).toHaveBeenCalledTimes(1);

    mockedListContacts.mockResolvedValueOnce({
      contacts: [fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' })],
    });
    await user.press(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });
    expect(mockedListContacts).toHaveBeenCalledTimes(2);
  });

  it('navigates to AddContact when "Add contact" is pressed', async () => {
    mockedListContacts.mockResolvedValueOnce({ contacts: [] });
    const { navigation, user } = await renderFriendsScreen();

    await waitFor(() => {
      expect(screen.getByText('No contacts yet')).toBeTruthy();
    });

    await user.press(screen.getByRole('button', { name: 'Add contact' }));

    expect(navigation.navigate).toHaveBeenCalledWith('AddContact');
  });

  it('navigates to Settings when the gear icon is pressed', async () => {
    mockedListContacts.mockResolvedValueOnce({ contacts: [] });
    const { navigation, user } = await renderFriendsScreen();

    await waitFor(() => {
      expect(screen.getByText('No contacts yet')).toBeTruthy();
    });

    await user.press(screen.getByRole('button', { name: 'Settings' }));

    expect(navigation.navigate).toHaveBeenCalledWith('Settings');
  });

  it('renders dark: variants on its background, header, and empty-state text', async () => {
    mockedListContacts.mockResolvedValueOnce({ contacts: [] });
    await renderFriendsScreen();

    await waitFor(() => {
      expect(screen.getByText('No contacts yet')).toBeTruthy();
    });

    expect(screen.getByText('Friends').props.className).toContain('dark:text-white');
    expect(screen.getByText('No contacts yet').props.className).toContain('dark:text-gray-400');
  });

  it('navigates to Chat with the contact userId and email when a fully-keyed row is tapped', async () => {
    mockedListContacts.mockResolvedValueOnce({
      contacts: [fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' })],
    });
    const { navigation, user } = await renderFriendsScreen();

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });

    await user.press(screen.getByText('alice@example.com'));

    expect(navigation.navigate).toHaveBeenCalledWith('Chat', {
      userId: 'u1',
      email: 'alice@example.com',
    });
  });

  it('renders a contact missing any key field as disabled and does not navigate on tap', async () => {
    mockedListContacts.mockResolvedValueOnce({
      contacts: [unkeyedContact({ user_id: 'u1', email: 'carol@example.com' })],
    });
    const { navigation, user } = await renderFriendsScreen();

    await waitFor(() => {
      expect(screen.getByText('carol@example.com')).toBeTruthy();
    });

    expect(screen.getByText('Waiting for carol@example.com to finish setup')).toBeTruthy();
    expect(screen.getByRole('button', { name: /carol@example.com/ })).toBeDisabled();

    await user.press(screen.getByText('carol@example.com'));

    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('renders a contact with only one null key field as disabled', async () => {
    mockedListContacts.mockResolvedValueOnce({
      contacts: [
        {
          ...fullyKeyedContact({ user_id: 'u1', email: 'dave@example.com' }),
          prekey_signature_b64: null,
        },
      ],
    });
    const { navigation, user } = await renderFriendsScreen();

    await waitFor(() => {
      expect(screen.getByText('dave@example.com')).toBeTruthy();
    });

    expect(screen.getByText('Waiting for dave@example.com to finish setup')).toBeTruthy();

    await user.press(screen.getByText('dave@example.com'));

    expect(navigation.navigate).not.toHaveBeenCalled();
  });
});
