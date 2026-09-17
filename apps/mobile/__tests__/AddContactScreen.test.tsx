import { render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import AddContactScreen from '../src/screens/AddContactScreen';
import { acceptContactRequest, searchUsers, sendContactRequest } from '../src/api/client';

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
  class IncomingRequestExistsError extends ApiError {
    requestId: string;
    constructor(requestId: string) {
      super('incoming_request_exists', 409);
      this.name = 'IncomingRequestExistsError';
      this.requestId = requestId;
    }
  }
  return {
    ApiError,
    IncomingRequestExistsError,
    searchUsers: jest.fn(),
    sendContactRequest: jest.fn(),
    acceptContactRequest: jest.fn(),
  };
});

const mockedSearchUsers = searchUsers as jest.Mock;
const mockedSendContactRequest = sendContactRequest as jest.Mock;
const mockedAcceptContactRequest = acceptContactRequest as jest.Mock;

jest.setTimeout(15000);

/** Jest has no native safe-area module; seed metrics so the provider
 * renders children immediately instead of waiting forever. */
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

async function renderAddContactScreen() {
  const navigation = { navigate: jest.fn(), goBack: jest.fn() };
  const user = userEvent.setup();
  await render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <AddContactScreen navigation={navigation as never} route={{} as never} />
    </SafeAreaProvider>
  );
  return { navigation, user };
}

describe('AddContactScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSearchUsers.mockResolvedValue({ users: [] });
  });

  it('renders dark: variants on its title and search field', async () => {
    await renderAddContactScreen();

    expect(screen.getByText('Add contact').props.className).toContain('dark:text-white');
    expect(screen.getByPlaceholderText('Search by email').props.className).toContain(
      'dark:text-white'
    );
  });

  it('does not call the search endpoint below the minimum query length', async () => {
    const { user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Search by email'), 'ab');

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(mockedSearchUsers).not.toHaveBeenCalled();
    expect(screen.queryByTestId(/^search-result-/)).toBeNull();
  });

  it('calls the search endpoint once the query reaches the minimum length, debounced', async () => {
    mockedSearchUsers.mockResolvedValueOnce({
      users: [{ user_id: 'u1', email: 'alice@example.com' }],
    });
    const { user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Search by email'), 'ali');

    await waitFor(() => {
      expect(mockedSearchUsers).toHaveBeenCalledWith('ali');
    });
    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });
  });

  it('renders each result with two independent tap targets: a row and an add button', async () => {
    mockedSearchUsers.mockResolvedValueOnce({
      users: [{ user_id: 'u1', email: 'alice@example.com' }],
    });
    const { user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Search by email'), 'ali');

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Add alice@example.com' })).toBeTruthy();
  });

  it('tapping the add button calls sendContactRequest and does not navigate', async () => {
    mockedSearchUsers.mockResolvedValueOnce({
      users: [{ user_id: 'u1', email: 'alice@example.com' }],
    });
    mockedSendContactRequest.mockResolvedValueOnce({
      id: 'r1',
      requester_user_id: 'me',
      recipient_user_id: 'u1',
      status: 'pending',
      created_at: '2024-01-01T00:00:00Z',
    });
    const { navigation, user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Search by email'), 'ali');
    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });

    await user.press(screen.getByRole('button', { name: 'Add alice@example.com' }));

    await waitFor(() => {
      expect(mockedSendContactRequest).toHaveBeenCalledWith('alice@example.com');
      expect(screen.getByText('Sent')).toBeTruthy();
    });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('tapping the row navigates to UserProfile with the result id/email and does not send a request', async () => {
    mockedSearchUsers.mockResolvedValueOnce({
      users: [{ user_id: 'u1', email: 'alice@example.com' }],
    });
    const { navigation, user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Search by email'), 'ali');
    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });

    await user.press(screen.getByText('alice@example.com'));

    expect(navigation.navigate).toHaveBeenCalledWith('UserProfile', {
      userId: 'u1',
      email: 'alice@example.com',
    });
    expect(mockedSendContactRequest).not.toHaveBeenCalled();
  });

  it('shows a distinct message for a 429 rate_limited response', async () => {
    const { ApiError } = jest.requireMock('../src/api/client');
    mockedSearchUsers.mockRejectedValueOnce(new ApiError('rate_limited', 429));
    const { user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Search by email'), 'ali');

    await waitFor(() => {
      expect(screen.getByText('Try again in a moment')).toBeTruthy();
    });
  });

  it('shows a generic message for a non-rate-limit search failure', async () => {
    const { ApiError } = jest.requireMock('../src/api/client');
    mockedSearchUsers.mockRejectedValueOnce(new ApiError('internal_error', 500));
    const { user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Search by email'), 'ali');

    await waitFor(() => {
      expect(screen.getByText('Something went wrong')).toBeTruthy();
    });
    expect(screen.queryByText('Try again in a moment')).toBeNull();
  });

  it.each([
    ['user_not_found', 'No user with that email'],
    ['already_pending', 'You already sent this person a request'],
    ['already_contact', 'Already in your contacts'],
    ['cannot_add_self', "You can't add yourself"],
  ])('shows "%s" as "%s" on the row when the add fails', async (code, expectedMessage) => {
    mockedSearchUsers.mockResolvedValueOnce({
      users: [{ user_id: 'u1', email: 'alice@example.com' }],
    });
    const { ApiError } = jest.requireMock('../src/api/client');
    mockedSendContactRequest.mockRejectedValueOnce(new ApiError(code, 400));
    const { navigation, user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Search by email'), 'ali');
    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });

    await user.press(screen.getByRole('button', { name: 'Add alice@example.com' }));

    await waitFor(() => {
      expect(screen.getByText(expectedMessage)).toBeTruthy();
    });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  describe('crossed-request prompt', () => {
    function crossedRequestError(requestId: string) {
      const { IncomingRequestExistsError } = jest.requireMock('../src/api/client');
      return new IncomingRequestExistsError(requestId);
    }

    async function searchAndAdd(user: ReturnType<typeof userEvent.setup>) {
      await user.type(screen.getByPlaceholderText('Search by email'), 'ali');
      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeTruthy();
      });
      await user.press(screen.getByRole('button', { name: 'Add alice@example.com' }));
    }

    beforeEach(() => {
      mockedSearchUsers.mockResolvedValueOnce({
        users: [{ user_id: 'u1', email: 'alice@example.com' }],
      });
    });

    it('shows an accept prompt with the target email on 409 incoming_request_exists', async () => {
      mockedSendContactRequest.mockRejectedValueOnce(crossedRequestError('r1'));
      const { user } = await renderAddContactScreen();

      await searchAndAdd(user);

      await waitFor(() => {
        expect(screen.getByText('alice@example.com already sent you a request')).toBeTruthy();
      });
      expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    });

    it('calls acceptContactRequest with the carried request id and shows a confirmation on success', async () => {
      mockedSendContactRequest.mockRejectedValueOnce(crossedRequestError('r1'));
      mockedAcceptContactRequest.mockResolvedValueOnce(undefined);
      const { user } = await renderAddContactScreen();

      await searchAndAdd(user);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
      });
      await user.press(screen.getByRole('button', { name: 'Accept' }));

      expect(mockedAcceptContactRequest).toHaveBeenCalledWith('r1');
      await waitFor(() => {
        expect(screen.getByText('Request accepted')).toBeTruthy();
      });
    });

    it('leaves the accept prompt in place with an inline error when accept fails', async () => {
      const { ApiError } = jest.requireMock('../src/api/client');
      mockedSendContactRequest.mockRejectedValueOnce(crossedRequestError('r1'));
      mockedAcceptContactRequest.mockRejectedValueOnce(new ApiError('request_not_found', 404));
      const { user } = await renderAddContactScreen();

      await searchAndAdd(user);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
      });
      await user.press(screen.getByRole('button', { name: 'Accept' }));

      await waitFor(() => {
        expect(screen.getByText('Something went wrong')).toBeTruthy();
      });
      expect(screen.getByText('alice@example.com already sent you a request')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    });
  });
});
