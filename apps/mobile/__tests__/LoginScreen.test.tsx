import { render, screen, userEvent, waitFor } from '@testing-library/react-native';

import LoginScreen from '../src/screens/LoginScreen';
import { login, signup } from '../src/api/client';
import { ensureKeysRegistered } from '../src/crypto/keyRegistration';

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
    login: jest.fn(),
    signup: jest.fn(),
  };
});

jest.mock('../src/crypto/keyRegistration', () => ({
  ensureKeysRegistered: jest.fn(),
}));

const mockedLogin = login as jest.Mock;
const mockedSignup = signup as jest.Mock;
const mockedEnsureKeysRegistered = ensureKeysRegistered as jest.Mock;

async function renderLoginScreen() {
  const navigation = { replace: jest.fn() };
  const user = userEvent.setup();
  await render(<LoginScreen navigation={navigation as never} route={{} as never} />);
  return { navigation, user };
}

describe('LoginScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('disables the submit button when the email or password field is empty', async () => {
    const { user } = await renderLoginScreen();

    expect(screen.getByRole('button', { name: 'Log in' })).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    expect(screen.getByRole('button', { name: 'Log in' })).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Password'), 'hunter2');
    expect(screen.getByRole('button', { name: 'Log in' })).toBeEnabled();
  });

  it('does not call the API when submit is pressed with an empty field', async () => {
    const { user } = await renderLoginScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.press(screen.getByRole('button', { name: 'Log in' }));

    expect(mockedLogin).not.toHaveBeenCalled();
  });

  it('renders the ApiError message and does not navigate when login fails', async () => {
    const { ApiError } = jest.requireMock('../src/api/client');
    mockedLogin.mockRejectedValueOnce(new ApiError('invalid credentials', 401));
    const { navigation, user } = await renderLoginScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'wrong');
    await user.press(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => {
      expect(screen.getByText('invalid credentials')).toBeTruthy();
    });
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('navigates to Contacts when login succeeds', async () => {
    mockedLogin.mockResolvedValueOnce({ token: 'tok-1', user: {} });
    const { navigation, user } = await renderLoginScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'hunter2');
    await user.press(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith('Contacts');
    });
  });

  it('switches to sign-up mode and calls signup() on submit', async () => {
    mockedSignup.mockResolvedValueOnce({ token: 'tok-2', user: {} });
    const { navigation, user } = await renderLoginScreen();

    await user.press(screen.getByText(/sign up/i));
    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'hunter2');
    await user.press(screen.getByRole('button', { name: 'Sign up' }));

    await waitFor(() => {
      expect(mockedSignup).toHaveBeenCalledWith('a@example.com', 'hunter2');
      expect(navigation.replace).toHaveBeenCalledWith('Contacts');
    });
  });

  it('calls ensureKeysRegistered with the authenticated user id after a successful login', async () => {
    mockedLogin.mockResolvedValueOnce({ token: 'tok-1', user: { id: 'user-123' } });
    const { user } = await renderLoginScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'hunter2');
    await user.press(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => {
      expect(mockedEnsureKeysRegistered).toHaveBeenCalledWith('user-123');
    });
  });

  it('calls ensureKeysRegistered with the authenticated user id after a successful signup', async () => {
    mockedSignup.mockResolvedValueOnce({ token: 'tok-2', user: { id: 'user-456' } });
    const { user } = await renderLoginScreen();

    await user.press(screen.getByText(/sign up/i));
    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'hunter2');
    await user.press(screen.getByRole('button', { name: 'Sign up' }));

    await waitFor(() => {
      expect(mockedEnsureKeysRegistered).toHaveBeenCalledWith('user-456');
    });
  });

  it('does not call ensureKeysRegistered when the user object has no id', async () => {
    mockedLogin.mockResolvedValueOnce({ token: 'tok-1', user: {} });
    const { navigation, user } = await renderLoginScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'hunter2');
    await user.press(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith('Contacts');
    });
    expect(mockedEnsureKeysRegistered).not.toHaveBeenCalled();
  });

  it('still navigates to Contacts when ensureKeysRegistered rejects', async () => {
    mockedLogin.mockResolvedValueOnce({ token: 'tok-1', user: { id: 'user-123' } });
    mockedEnsureKeysRegistered.mockRejectedValueOnce(new Error('network error'));
    const { navigation, user } = await renderLoginScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'hunter2');
    await user.press(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith('Contacts');
    });
  });
});
