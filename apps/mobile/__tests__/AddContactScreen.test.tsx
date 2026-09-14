import { render, screen, userEvent, waitFor } from '@testing-library/react-native';

import AddContactScreen from '../src/screens/AddContactScreen';
import { acceptContactRequest, sendContactRequest } from '../src/api/client';

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
    sendContactRequest: jest.fn(),
    acceptContactRequest: jest.fn(),
  };
});

const mockedSendContactRequest = sendContactRequest as jest.Mock;
const mockedAcceptContactRequest = acceptContactRequest as jest.Mock;

async function renderAddContactScreen() {
  const navigation = { navigate: jest.fn(), goBack: jest.fn() };
  const user = userEvent.setup();
  await render(<AddContactScreen navigation={navigation as never} route={{} as never} />);
  return { navigation, user };
}

describe('AddContactScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders dark: variants on its title and input field', async () => {
    await renderAddContactScreen();

    expect(screen.getByText('Add contact').props.className).toContain('dark:text-white');
    expect(screen.getByPlaceholderText('Email').props.className).toContain('dark:text-white');
  });

  it('disables the submit button when the email field is empty or does not contain an @', async () => {
    const { user } = await renderAddContactScreen();

    expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Email'), 'not-an-email');
    expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Email'), '@example.com');
    expect(screen.getByRole('button', { name: 'Send request' })).toBeEnabled();
  });

  it('does not call the API when submit is pressed with an invalid-looking email', async () => {
    const { user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'not-an-email');
    await user.press(screen.getByRole('button', { name: 'Send request' }));

    expect(mockedSendContactRequest).not.toHaveBeenCalled();
  });

  it('shows a "Request sent" confirmation and does not navigate away on success', async () => {
    mockedSendContactRequest.mockResolvedValueOnce({
      id: 'r1',
      requester_user_id: 'u1',
      recipient_user_id: 'u2',
      status: 'pending',
      created_at: '2024-01-01T00:00:00Z',
    });
    const { navigation, user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.press(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() => {
      expect(mockedSendContactRequest).toHaveBeenCalledWith('a@example.com');
      expect(screen.getByText('Request sent')).toBeTruthy();
    });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it.each([
    ['user_not_found', 'No user with that email'],
    ['already_pending', 'You already sent this person a request'],
    ['already_contact', 'Already in your contacts'],
    ['cannot_add_self', "You can't add yourself"],
  ])('shows "%s" as "%s" and does not navigate away', async (code, expectedMessage) => {
    const { ApiError } = jest.requireMock('../src/api/client');
    mockedSendContactRequest.mockRejectedValueOnce(new ApiError(code, 400));
    const { navigation, user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.press(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() => {
      expect(screen.getByText(expectedMessage)).toBeTruthy();
    });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('shows a generic message for any other error, including network failure, and does not navigate away', async () => {
    const { ApiError } = jest.requireMock('../src/api/client');
    mockedSendContactRequest.mockRejectedValueOnce(new ApiError('network_error', 0));
    const { navigation, user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.press(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() => {
      expect(screen.getByText('Something went wrong')).toBeTruthy();
    });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('shows a generic message for a real network failure (rejection that is not an ApiError) and does not navigate away', async () => {
    mockedSendContactRequest.mockRejectedValueOnce(new TypeError('Network request failed'));
    const { navigation, user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.press(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() => {
      expect(screen.getByText('Something went wrong')).toBeTruthy();
    });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  describe('crossed-request prompt', () => {
    function crossedRequestError(requestId: string) {
      const { IncomingRequestExistsError } = jest.requireMock('../src/api/client');
      return new IncomingRequestExistsError(requestId);
    }

    it('shows an accept prompt with the target email on 409 incoming_request_exists', async () => {
      mockedSendContactRequest.mockRejectedValueOnce(crossedRequestError('r1'));
      const { user } = await renderAddContactScreen();

      await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
      await user.press(screen.getByRole('button', { name: 'Send request' }));

      await waitFor(() => {
        expect(screen.getByText('a@example.com already sent you a request')).toBeTruthy();
      });
      expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    });

    it('calls acceptContactRequest with the carried request id and shows a confirmation on success', async () => {
      mockedSendContactRequest.mockRejectedValueOnce(crossedRequestError('r1'));
      mockedAcceptContactRequest.mockResolvedValueOnce(undefined);
      const { user } = await renderAddContactScreen();

      await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
      await user.press(screen.getByRole('button', { name: 'Send request' }));

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

      await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
      await user.press(screen.getByRole('button', { name: 'Send request' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
      });
      await user.press(screen.getByRole('button', { name: 'Accept' }));

      await waitFor(() => {
        expect(screen.getByText('Something went wrong')).toBeTruthy();
      });
      expect(screen.getByText('a@example.com already sent you a request')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    });
  });
});
