import { Alert } from 'react-native';

import { act, fireEvent, render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import FriendsScreen from '../src/screens/FriendsScreen';
import {
  acceptContactRequest,
  declineContactRequest,
  listContactRequests,
  listContacts,
  removeContact,
} from '../src/api/client';
import { getToken } from '../src/api/session';

/** Jest has no native safe-area module; seed metrics so the provider
 * renders children immediately instead of waiting forever. */
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

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
    removeContact: jest.fn(),
    acceptContactRequest: jest.fn(),
    declineContactRequest: jest.fn(),
    // `../src/components/Avatar.tsx` (issue #182) also imports
    // `API_BASE_URL` from this module -- since this whole module is
    // mocked in this file, that import would otherwise resolve to
    // `undefined` rather than the real client's computed default.
    API_BASE_URL: 'http://localhost:3000',
  };
});

jest.mock('../src/api/session', () => ({
  getToken: jest.fn(),
}));

const mockedListContacts = listContacts as jest.Mock;
const mockedListContactRequests = listContactRequests as jest.Mock;
const mockedRemoveContact = removeContact as jest.Mock;
const mockedAcceptContactRequest = acceptContactRequest as jest.Mock;
const mockedDeclineContactRequest = declineContactRequest as jest.Mock;
const mockedGetToken = getToken as jest.Mock;

const EMPTY_REQUESTS = { incoming: [], outgoing: [] };

function requestParty(overrides: {
  id: string;
  user_id: string;
  email: string;
  username?: string;
  created_at?: string;
}) {
  return {
    created_at: '2024-01-01T00:00:00Z',
    username: overrides.email.split('@')[0],
    ...overrides,
  };
}

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

function makeNavigation() {
  return {
    navigate: jest.fn(),
    addListener: jest.fn((_event: string, _handler: () => void) => jest.fn()),
  };
}

async function renderFriendsScreen(navigation = makeNavigation()) {
  const user = userEvent.setup();
  await render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <FriendsScreen navigation={navigation as never} route={{} as never} />
    </SafeAreaProvider>
  );
  return { navigation, user };
}

function fullyKeyedContact(overrides: {
  user_id: string;
  email: string;
  added_at?: string;
}) {
  return {
    username: overrides.email.split('@')[0],
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
    username: overrides.email.split('@')[0],
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
    // Every test cares about `listContacts()`'s behavior specifically, not
    // the Requests section, unless it overrides this with a `*Once` mock --
    // this default keeps `Promise.all([listContacts(), listContactRequests()])`
    // resolving without every existing Friends-section test having to know
    // about the Requests fetch.
    mockedListContactRequests.mockResolvedValue(EMPTY_REQUESTS);
    // No session token by default -- every row's avatar (issue #182) falls
    // back to its initial circle, matching this file's other assertions.
    // Overridden per-test in the "row avatar" describe block below.
    mockedGetToken.mockResolvedValue(null);
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

  it('renders each contact username once loaded', async () => {
    mockedListContacts.mockResolvedValueOnce({
      contacts: [
        fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' }),
        fullyKeyedContact({ user_id: 'u2', email: 'bob@example.com', added_at: '2024-01-02T00:00:00Z' }),
      ],
    });

    await renderFriendsScreen();

    await waitFor(() => {
      expect(screen.getByText('alice')).toBeTruthy();
      expect(screen.getByText('bob')).toBeTruthy();
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
      expect(screen.getByText('alice')).toBeTruthy();
    });
    expect(mockedListContacts).toHaveBeenCalledTimes(2);
  });

  it('refetches when the screen regains focus', async () => {
    mockedListContacts.mockResolvedValueOnce({ contacts: [] });
    mockedListContactRequests.mockResolvedValueOnce(EMPTY_REQUESTS);
    const navigation = makeNavigation();
    await renderFriendsScreen(navigation);

    await waitFor(() => {
      expect(screen.getByText('No contacts yet')).toBeTruthy();
    });
    expect(mockedListContacts).toHaveBeenCalledTimes(1);

    const focusCall = navigation.addListener.mock.calls.find(([event]) => event === 'focus');
    expect(focusCall).toBeTruthy();
    const focusHandler = focusCall![1] as () => void;

    mockedListContacts.mockResolvedValueOnce({
      contacts: [fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' })],
    });
    mockedListContactRequests.mockResolvedValueOnce(EMPTY_REQUESTS);

    await act(async () => {
      focusHandler();
    });

    await waitFor(() => {
      expect(screen.getByText('alice')).toBeTruthy();
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

  it('navigates to Chat with the contact userId and username when a fully-keyed row is tapped', async () => {
    mockedListContacts.mockResolvedValueOnce({
      contacts: [fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' })],
    });
    const { navigation, user } = await renderFriendsScreen();

    await waitFor(() => {
      expect(screen.getByText('alice')).toBeTruthy();
    });

    await user.press(screen.getByText('alice'));

    expect(navigation.navigate).toHaveBeenCalledWith('Chat', {
      userId: 'u1',
      username: 'alice',
    });
  });

  it('renders a contact missing any key field as disabled and does not navigate on tap', async () => {
    mockedListContacts.mockResolvedValueOnce({
      contacts: [unkeyedContact({ user_id: 'u1', email: 'carol@example.com' })],
    });
    const { navigation, user } = await renderFriendsScreen();

    await waitFor(() => {
      expect(screen.getByText('carol')).toBeTruthy();
    });

    expect(screen.getByText('Waiting for carol to finish setup')).toBeTruthy();
    expect(screen.getByRole('button', { name: /carol/ })).toBeDisabled();

    await user.press(screen.getByText('carol'));

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
      expect(screen.getByText('dave')).toBeTruthy();
    });

    expect(screen.getByText('Waiting for dave to finish setup')).toBeTruthy();

    await user.press(screen.getByText('dave'));

    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  describe('Friends search filter (issue #104)', () => {
    it('filters the Friends section by case-insensitive username substring', async () => {
      mockedListContacts.mockResolvedValueOnce({
        contacts: [
          fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' }),
          fullyKeyedContact({ user_id: 'u2', email: 'bob@example.com' }),
        ],
      });
      const { user } = await renderFriendsScreen();

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeTruthy();
        expect(screen.getByText('bob')).toBeTruthy();
      });

      await user.type(screen.getByTestId('friends-search-input'), 'ALI');

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeTruthy();
        expect(screen.queryByText('bob')).toBeNull();
      });
    });

    it('does not match a query that only matches the contact email', async () => {
      mockedListContacts.mockResolvedValueOnce({
        contacts: [fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' })],
      });
      const { user } = await renderFriendsScreen();
      const input = await screen.findByTestId('friends-search-input');

      await user.type(input, 'example.com');

      await waitFor(() => {
        expect(screen.getByText('No matching friends')).toBeTruthy();
      });
    });

    it('shows the full Friends list again once the query is cleared', async () => {
      mockedListContacts.mockResolvedValueOnce({
        contacts: [
          fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' }),
          fullyKeyedContact({ user_id: 'u2', email: 'bob@example.com' }),
        ],
      });
      const { user } = await renderFriendsScreen();
      const input = await screen.findByTestId('friends-search-input');

      await user.type(input, 'ali');
      await waitFor(() => {
        expect(screen.queryByText('bob')).toBeNull();
      });

      await user.clear(input);

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeTruthy();
        expect(screen.getByText('bob')).toBeTruthy();
      });
    });

    it('shows a distinct "No matching friends" message for a non-matching query', async () => {
      mockedListContacts.mockResolvedValueOnce({
        contacts: [fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' })],
      });
      const { user } = await renderFriendsScreen();
      const input = await screen.findByTestId('friends-search-input');

      await user.type(input, 'zzz');

      await waitFor(() => {
        expect(screen.getByText('No matching friends')).toBeTruthy();
        expect(screen.queryByText('alice')).toBeNull();
      });
    });

    it('leaves the Requests section unaffected by a query that matches no friend', async () => {
      mockedListContacts.mockResolvedValueOnce({
        contacts: [fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' })],
      });
      mockedListContactRequests.mockResolvedValueOnce({
        incoming: [requestParty({ id: 'r1', user_id: 'u2', email: 'carol@example.com' })],
        outgoing: [],
      });
      const { user } = await renderFriendsScreen();
      const input = await screen.findByTestId('friends-search-input');

      await waitFor(() => {
        expect(screen.getByTestId('requests-section')).toBeTruthy();
      });

      // Query matches neither the friend nor the pending request's email.
      await user.type(input, 'zzz');

      await waitFor(() => {
        expect(screen.getByText('No matching friends')).toBeTruthy();
      });
      // The Requests section -- and carol's row within it -- stays exactly
      // as it was; the query never touches `requests` at all.
      expect(screen.getByTestId('requests-section')).toBeTruthy();
      expect(screen.getByText('carol')).toBeTruthy();
    });
  });

  describe('remove action', () => {
    /** Simulates the user confirming the "Remove" destructive option of the
     * long-press `Alert.alert` context menu -- see `FriendsScreen`'s
     * `handleLongPressFriend`. */
    function confirmRemoveOnNextAlert() {
      return jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
        const removeButton = buttons?.find((button) => button.text === 'Remove');
        removeButton?.onPress?.();
      });
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('calls removeContact and removes the row from the list on success', async () => {
      mockedListContacts.mockResolvedValueOnce({
        contacts: [fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' })],
      });
      mockedRemoveContact.mockResolvedValueOnce(undefined);
      confirmRemoveOnNextAlert();
      const { user } = await renderFriendsScreen();

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeTruthy();
      });

      await user.longPress(screen.getByText('alice'));

      expect(mockedRemoveContact).toHaveBeenCalledWith('u1');
      await waitFor(() => {
        expect(screen.queryByText('alice')).toBeNull();
      });
    });

    it('leaves the row in place and shows an inline error on failure', async () => {
      const { ApiError } = jest.requireMock('../src/api/client');
      mockedListContacts.mockResolvedValueOnce({
        contacts: [fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' })],
      });
      mockedRemoveContact.mockRejectedValueOnce(new ApiError('not_found', 404));
      confirmRemoveOnNextAlert();
      const { user } = await renderFriendsScreen();

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeTruthy();
      });

      await user.longPress(screen.getByText('alice'));

      await waitFor(() => {
        expect(screen.getByText('not_found')).toBeTruthy();
      });
      expect(screen.getByText('alice')).toBeTruthy();
    });
  });

  describe('Requests section', () => {
    it('is not rendered when there are no pending requests', async () => {
      mockedListContacts.mockResolvedValueOnce({ contacts: [] });
      mockedListContactRequests.mockResolvedValueOnce(EMPTY_REQUESTS);

      await renderFriendsScreen();

      await waitFor(() => {
        expect(screen.getByText('No contacts yet')).toBeTruthy();
      });
      expect(screen.queryByTestId('requests-section')).toBeNull();
    });

    it('is rendered when there is at least one incoming request', async () => {
      mockedListContacts.mockResolvedValueOnce({ contacts: [] });
      mockedListContactRequests.mockResolvedValueOnce({
        incoming: [requestParty({ id: 'r1', user_id: 'u1', email: 'alice@example.com' })],
        outgoing: [],
      });

      await renderFriendsScreen();

      await waitFor(() => {
        expect(screen.getByTestId('requests-section')).toBeTruthy();
      });
      expect(screen.getByText('alice')).toBeTruthy();
      expect(screen.queryByText('alice@example.com')).toBeNull();
    });

    it('falls back to the email when an incoming request has no username', async () => {
      mockedListContacts.mockResolvedValueOnce({ contacts: [] });
      mockedListContactRequests.mockResolvedValueOnce({
        incoming: [
          requestParty({ id: 'r1', user_id: 'u1', email: 'alice@example.com', username: undefined }),
        ],
        outgoing: [],
      });

      await renderFriendsScreen();

      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeTruthy();
      });
    });

    it('is rendered when there is at least one outgoing request', async () => {
      mockedListContacts.mockResolvedValueOnce({ contacts: [] });
      mockedListContactRequests.mockResolvedValueOnce({
        incoming: [],
        outgoing: [requestParty({ id: 'r2', user_id: 'u2', email: 'bob@example.com' })],
      });

      await renderFriendsScreen();

      await waitFor(() => {
        expect(screen.getByTestId('requests-section')).toBeTruthy();
      });
      expect(screen.getByText('bob')).toBeTruthy();
      expect(screen.queryByText('bob@example.com')).toBeNull();
    });

    it('renders an outgoing request read-only as "Pending"', async () => {
      mockedListContacts.mockResolvedValueOnce({ contacts: [] });
      mockedListContactRequests.mockResolvedValueOnce({
        incoming: [],
        outgoing: [requestParty({ id: 'r2', user_id: 'u2', email: 'bob@example.com' })],
      });

      await renderFriendsScreen();

      await waitFor(() => {
        expect(screen.getByText('Pending')).toBeTruthy();
      });
      expect(screen.queryByRole('button', { name: 'Accept bob' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Decline bob' })).toBeNull();
    });

    it('accepts an incoming request, removing it from the section and showing the new contact', async () => {
      mockedListContacts.mockResolvedValueOnce({ contacts: [] });
      mockedListContactRequests.mockResolvedValueOnce({
        incoming: [requestParty({ id: 'r1', user_id: 'u1', email: 'alice@example.com' })],
        outgoing: [],
      });
      mockedAcceptContactRequest.mockResolvedValueOnce(undefined);
      // Post-accept refresh of both lists (mutual contacts now exist).
      mockedListContacts.mockResolvedValueOnce({
        contacts: [fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' })],
      });
      mockedListContactRequests.mockResolvedValueOnce(EMPTY_REQUESTS);
      const { user } = await renderFriendsScreen();

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeTruthy();
      });

      await user.press(screen.getByRole('button', { name: 'Accept alice' }));

      expect(mockedAcceptContactRequest).toHaveBeenCalledWith('r1');
      await waitFor(() => {
        expect(screen.queryByTestId('requests-section')).toBeNull();
      });
      expect(screen.getByText('alice')).toBeTruthy();
      expect(screen.queryByText('No contacts yet')).toBeNull();
    });

    it('leaves an incoming request in place and shows an inline error when accept fails', async () => {
      const { ApiError } = jest.requireMock('../src/api/client');
      mockedListContacts.mockResolvedValueOnce({ contacts: [] });
      mockedListContactRequests.mockResolvedValueOnce({
        incoming: [requestParty({ id: 'r1', user_id: 'u1', email: 'alice@example.com' })],
        outgoing: [],
      });
      mockedAcceptContactRequest.mockRejectedValueOnce(new ApiError('request_not_found', 404));
      const { user } = await renderFriendsScreen();

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeTruthy();
      });

      await user.press(screen.getByRole('button', { name: 'Accept alice' }));

      await waitFor(() => {
        expect(screen.getByText('request_not_found')).toBeTruthy();
      });
      expect(screen.getByText('alice')).toBeTruthy();
    });

    it('declines an incoming request, removing it from the section, on success', async () => {
      mockedListContacts.mockResolvedValueOnce({ contacts: [] });
      mockedListContactRequests.mockResolvedValueOnce({
        incoming: [requestParty({ id: 'r1', user_id: 'u1', email: 'alice@example.com' })],
        outgoing: [],
      });
      mockedDeclineContactRequest.mockResolvedValueOnce(undefined);
      const { user } = await renderFriendsScreen();

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeTruthy();
      });

      await user.press(screen.getByRole('button', { name: 'Decline alice' }));

      expect(mockedDeclineContactRequest).toHaveBeenCalledWith('r1');
      await waitFor(() => {
        expect(screen.queryByTestId('requests-section')).toBeNull();
      });
    });

    it('leaves an incoming request in place and shows an inline error when decline fails', async () => {
      const { ApiError } = jest.requireMock('../src/api/client');
      mockedListContacts.mockResolvedValueOnce({ contacts: [] });
      mockedListContactRequests.mockResolvedValueOnce({
        incoming: [requestParty({ id: 'r1', user_id: 'u1', email: 'alice@example.com' })],
        outgoing: [],
      });
      mockedDeclineContactRequest.mockRejectedValueOnce(new ApiError('request_not_found', 404));
      const { user } = await renderFriendsScreen();

      await waitFor(() => {
        expect(screen.getByText('alice')).toBeTruthy();
      });

      await user.press(screen.getByRole('button', { name: 'Decline alice' }));

      await waitFor(() => {
        expect(screen.getByText('request_not_found')).toBeTruthy();
      });
      expect(screen.getByText('alice')).toBeTruthy();
    });
  });

  describe('row avatar (issue #182)', () => {
    it('renders the initial circle when there is no avatar to show', async () => {
      mockedListContacts.mockResolvedValueOnce({
        contacts: [fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' })],
      });

      await renderFriendsScreen();

      await waitFor(() => {
        expect(screen.getByText('A')).toBeTruthy();
      });
      expect(screen.queryByTestId('avatar-image-u1')).toBeNull();
    });

    it('attempts the real avatar image and falls back to the initial circle when it fails to load', async () => {
      mockedGetToken.mockResolvedValue('tok-1');
      mockedListContacts.mockResolvedValueOnce({
        contacts: [fullyKeyedContact({ user_id: 'u1', email: 'alice@example.com' })],
      });

      await renderFriendsScreen();

      const image = await waitFor(() => screen.getByTestId('avatar-image-u1'));
      expect(image.props.source).toEqual({
        uri: 'http://localhost:3000/api/avatar/u1',
        headers: { Authorization: 'Bearer tok-1' },
      });
      expect(screen.queryByText('A')).toBeNull();

      fireEvent(image, 'error');

      await waitFor(() => {
        expect(screen.getByText('A')).toBeTruthy();
      });
      expect(screen.queryByTestId('avatar-image-u1')).toBeNull();
    });
  });
});
