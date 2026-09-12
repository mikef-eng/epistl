import { render, screen, userEvent, waitFor } from '@testing-library/react-native';

import AddContactScreen from '../src/screens/AddContactScreen';
import { addContact } from '../src/api/client';

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
    addContact: jest.fn(),
  };
});

const mockedAddContact = addContact as jest.Mock;

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

  it('disables the submit button when the email field is empty or does not contain an @', async () => {
    const { user } = await renderAddContactScreen();

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Email'), 'not-an-email');
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Email'), '@example.com');
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('does not call the API when submit is pressed with an invalid-looking email', async () => {
    const { user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'not-an-email');
    await user.press(screen.getByRole('button', { name: 'Add' }));

    expect(mockedAddContact).not.toHaveBeenCalled();
  });

  it('navigates back to Contacts when addContact succeeds', async () => {
    mockedAddContact.mockResolvedValueOnce({
      user_id: 'u1',
      email: 'a@example.com',
      added_at: '2024-01-01T00:00:00Z',
    });
    const { navigation, user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.press(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(mockedAddContact).toHaveBeenCalledWith('a@example.com');
      expect(navigation.navigate).toHaveBeenCalledWith('Contacts');
    });
  });

  it.each([
    ['user_not_found', 'No user with that email'],
    ['already_added', 'Already in your contacts'],
    ['cannot_add_self', "You can't add yourself"],
  ])('shows "%s" as "%s" and does not navigate away', async (code, expectedMessage) => {
    const { ApiError } = jest.requireMock('../src/api/client');
    mockedAddContact.mockRejectedValueOnce(new ApiError(code, 400));
    const { navigation, user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.press(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(screen.getByText(expectedMessage)).toBeTruthy();
    });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('shows a generic message for any other error, including network failure, and does not navigate away', async () => {
    const { ApiError } = jest.requireMock('../src/api/client');
    mockedAddContact.mockRejectedValueOnce(new ApiError('network_error', 0));
    const { navigation, user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.press(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(screen.getByText('Something went wrong')).toBeTruthy();
    });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('shows a generic message for a real network failure (rejection that is not an ApiError) and does not navigate away', async () => {
    mockedAddContact.mockRejectedValueOnce(new TypeError('Network request failed'));
    const { navigation, user } = await renderAddContactScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.press(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(screen.getByText('Something went wrong')).toBeTruthy();
    });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });
});
