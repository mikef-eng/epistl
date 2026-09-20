import { render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import UserProfileScreen from '../src/screens/UserProfileScreen';
import {
  acceptContactRequest,
  cancelContactRequest,
  declineContactRequest,
  listContactRequests,
  listContacts,
  sendContactRequest,
} from '../src/api/client';

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
    listContacts: jest.fn(),
    listContactRequests: jest.fn(),
    sendContactRequest: jest.fn(),
    cancelContactRequest: jest.fn(),
    acceptContactRequest: jest.fn(),
    declineContactRequest: jest.fn(),
  };
});

const mockedListContacts = listContacts as jest.Mock;
const mockedListContactRequests = listContactRequests as jest.Mock;
const mockedSendContactRequest = sendContactRequest as jest.Mock;
const mockedCancelContactRequest = cancelContactRequest as jest.Mock;
const mockedAcceptContactRequest = acceptContactRequest as jest.Mock;
const mockedDeclineContactRequest = declineContactRequest as jest.Mock;

const TARGET_USER_ID = 'u1';
const TARGET_EMAIL = 'alice@example.com';
const TARGET_USERNAME = 'alice';
const ROUTE = { params: { userId: TARGET_USER_ID, username: TARGET_USERNAME, email: TARGET_EMAIL } };

const EMPTY_CONTACTS = { contacts: [] };
const EMPTY_REQUESTS = { incoming: [], outgoing: [] };

/** Jest has no native safe-area module; seed metrics so the provider
 * renders children immediately instead of waiting forever. */
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

async function renderUserProfileScreen() {
  const navigation = { navigate: jest.fn(), goBack: jest.fn() };
  const user = userEvent.setup();
  await render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <UserProfileScreen navigation={navigation as never} route={ROUTE as never} />
    </SafeAreaProvider>
  );
  return { navigation, user };
}

describe('UserProfileScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the target username as the title regardless of relationship state', async () => {
    mockedListContacts.mockResolvedValueOnce(EMPTY_CONTACTS);
    mockedListContactRequests.mockResolvedValueOnce(EMPTY_REQUESTS);

    await renderUserProfileScreen();

    expect(screen.getByText(TARGET_USERNAME)).toBeTruthy();
  });

  describe('unconnected', () => {
    beforeEach(() => {
      mockedListContacts.mockResolvedValue(EMPTY_CONTACTS);
      mockedListContactRequests.mockResolvedValue(EMPTY_REQUESTS);
    });

    it('renders exactly an "Add friend" button', async () => {
      await renderUserProfileScreen();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Add friend' })).toBeTruthy();
      });
      expect(screen.queryByText('Request pending')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
      expect(screen.queryByText('Friends')).toBeNull();
    });

    it('tapping "Add friend" calls sendContactRequest and moves to outgoing pending', async () => {
      mockedSendContactRequest.mockResolvedValueOnce({
        id: 'r1',
        requester_user_id: 'me',
        recipient_user_id: TARGET_USER_ID,
        status: 'pending',
        created_at: '2024-01-01T00:00:00Z',
      });
      const { user } = await renderUserProfileScreen();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Add friend' })).toBeTruthy();
      });
      await user.press(screen.getByRole('button', { name: 'Add friend' }));

      expect(mockedSendContactRequest).toHaveBeenCalledWith({ username: TARGET_USERNAME });
      await waitFor(() => {
        expect(screen.getByText('Request pending')).toBeTruthy();
      });
    });

    it('shows an inline error and stays unconnected when the add fails', async () => {
      const { ApiError } = jest.requireMock('../src/api/client');
      mockedSendContactRequest.mockRejectedValueOnce(new ApiError('already_pending', 400));
      const { user } = await renderUserProfileScreen();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Add friend' })).toBeTruthy();
      });
      await user.press(screen.getByRole('button', { name: 'Add friend' }));

      await waitFor(() => {
        expect(screen.getByText('You already sent this person a request')).toBeTruthy();
      });
      expect(screen.getByRole('button', { name: 'Add friend' })).toBeTruthy();
    });

    it('moves straight to incoming pending on a crossed 409 incoming_request_exists', async () => {
      const { IncomingRequestExistsError } = jest.requireMock('../src/api/client');
      mockedSendContactRequest.mockRejectedValueOnce(new IncomingRequestExistsError('r2'));
      const { user } = await renderUserProfileScreen();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Add friend' })).toBeTruthy();
      });
      await user.press(screen.getByRole('button', { name: 'Add friend' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
      });
      expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
    });
  });

  describe('outgoing pending', () => {
    beforeEach(() => {
      mockedListContacts.mockResolvedValue(EMPTY_CONTACTS);
      mockedListContactRequests.mockResolvedValue({
        incoming: [],
        outgoing: [{ id: 'r1', user_id: TARGET_USER_ID, email: TARGET_EMAIL, username: TARGET_USERNAME, created_at: 'now' }],
      });
    });

    it('renders a "Request pending" label with a Cancel button', async () => {
      await renderUserProfileScreen();

      await waitFor(() => {
        expect(screen.getByText('Request pending')).toBeTruthy();
      });
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Add friend' })).toBeNull();
    });

    it('tapping Cancel calls cancelContactRequest with the request id and moves to unconnected', async () => {
      mockedCancelContactRequest.mockResolvedValueOnce(undefined);
      const { user } = await renderUserProfileScreen();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
      });
      await user.press(screen.getByRole('button', { name: 'Cancel' }));

      expect(mockedCancelContactRequest).toHaveBeenCalledWith('r1');
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Add friend' })).toBeTruthy();
      });
    });

    it('shows an inline error and stays outgoing pending when cancel fails', async () => {
      const { ApiError } = jest.requireMock('../src/api/client');
      mockedCancelContactRequest.mockRejectedValueOnce(new ApiError('request_not_found', 404));
      const { user } = await renderUserProfileScreen();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
      });
      await user.press(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => {
        expect(screen.getByText('request_not_found')).toBeTruthy();
      });
      expect(screen.getByText('Request pending')).toBeTruthy();
    });
  });

  describe('incoming pending', () => {
    beforeEach(() => {
      mockedListContacts.mockResolvedValue(EMPTY_CONTACTS);
      mockedListContactRequests.mockResolvedValue({
        incoming: [{ id: 'r1', user_id: TARGET_USER_ID, email: TARGET_EMAIL, username: TARGET_USERNAME, created_at: 'now' }],
        outgoing: [],
      });
    });

    it('renders Accept and Decline buttons', async () => {
      await renderUserProfileScreen();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
      });
      expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Add friend' })).toBeNull();
    });

    it('tapping Accept calls acceptContactRequest with the request id and moves to friends', async () => {
      mockedAcceptContactRequest.mockResolvedValueOnce(undefined);
      const { user } = await renderUserProfileScreen();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
      });
      await user.press(screen.getByRole('button', { name: 'Accept' }));

      expect(mockedAcceptContactRequest).toHaveBeenCalledWith('r1');
      await waitFor(() => {
        expect(screen.getByText('Friends')).toBeTruthy();
      });
    });

    it('tapping Decline calls declineContactRequest with the request id and moves to unconnected', async () => {
      mockedDeclineContactRequest.mockResolvedValueOnce(undefined);
      const { user } = await renderUserProfileScreen();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
      });
      await user.press(screen.getByRole('button', { name: 'Decline' }));

      expect(mockedDeclineContactRequest).toHaveBeenCalledWith('r1');
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Add friend' })).toBeTruthy();
      });
    });
  });

  describe('already friends', () => {
    beforeEach(() => {
      mockedListContacts.mockResolvedValue({
        contacts: [
          {
            user_id: TARGET_USER_ID,
            email: TARGET_EMAIL,
            added_at: 'now',
            x25519_public_key_b64: null,
            kyber_public_key_b64: null,
            dilithium_public_key_b64: null,
            prekey_signature_b64: null,
          },
        ],
      });
      mockedListContactRequests.mockResolvedValue(EMPTY_REQUESTS);
    });

    it('renders a "Friends" label with no action', async () => {
      await renderUserProfileScreen();

      await waitFor(() => {
        expect(screen.getByText('Friends')).toBeTruthy();
      });
      expect(screen.queryByRole('button', { name: 'Add friend' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    });
  });

  it('shows an error with a retry option when the initial fetch fails', async () => {
    const { ApiError } = jest.requireMock('../src/api/client');
    mockedListContacts.mockRejectedValueOnce(new ApiError('internal_error', 500));
    mockedListContactRequests.mockResolvedValueOnce(EMPTY_REQUESTS);

    await renderUserProfileScreen();

    await waitFor(() => {
      expect(screen.getByText('internal_error')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('retries the fetch and renders the resolved state on success', async () => {
    const { ApiError } = jest.requireMock('../src/api/client');
    mockedListContacts.mockRejectedValueOnce(new ApiError('internal_error', 500));
    mockedListContactRequests.mockResolvedValueOnce(EMPTY_REQUESTS);
    const { user } = await renderUserProfileScreen();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    });

    mockedListContacts.mockResolvedValueOnce(EMPTY_CONTACTS);
    mockedListContactRequests.mockResolvedValueOnce(EMPTY_REQUESTS);
    await user.press(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add friend' })).toBeTruthy();
    });
  });
});
