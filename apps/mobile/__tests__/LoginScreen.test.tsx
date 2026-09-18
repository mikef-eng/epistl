import { render, screen, userEvent, waitFor } from '@testing-library/react-native';

import LoginScreen from '../src/screens/LoginScreen';
import { login, signup } from '../src/api/client';
import { saveUserId } from '../src/api/session';
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

jest.mock('../src/api/session', () => ({
  saveUserId: jest.fn(),
}));

const mockedLogin = login as jest.Mock;
const mockedSignup = signup as jest.Mock;
const mockedEnsureKeysRegistered = ensureKeysRegistered as jest.Mock;
const mockedSaveUserId = saveUserId as jest.Mock;

async function renderLoginScreen() {
  const navigation = { replace: jest.fn(), navigate: jest.fn() };
  const user = userEvent.setup();
  await render(<LoginScreen navigation={navigation as never} route={{} as never} />);
  return { navigation, user };
}

describe('LoginScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSaveUserId.mockResolvedValue(undefined);
  });

  it('renders dark: variants on its background and input fields', async () => {
    await renderLoginScreen();

    expect(screen.getByPlaceholderText('Email').props.className).toContain('dark:text-white');
    expect(screen.getByPlaceholderText('Password').props.className).toContain('dark:text-white');
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

  it('navigates to Main when login succeeds', async () => {
    mockedLogin.mockResolvedValueOnce({ token: 'tok-1', user: {} });
    const { navigation, user } = await renderLoginScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'hunter2');
    await user.press(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith('Main');
    });
  });

  it('switches to sign-up mode and navigates to SetupProfile with the entered email/password instead of calling signup() directly (issue #216)', async () => {
    const { navigation, user } = await renderLoginScreen();

    await user.press(screen.getByText(/sign up/i));
    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'hunter2');
    await user.press(screen.getByRole('button', { name: 'Sign up' }));

    await waitFor(() => {
      expect(navigation.navigate).toHaveBeenCalledWith('SetupProfile', {
        email: 'a@example.com',
        password: 'hunter2',
      });
    });
    expect(mockedSignup).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
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

  it('persists the authenticated user id after a successful login (issue #41)', async () => {
    mockedLogin.mockResolvedValueOnce({ token: 'tok-1', user: { id: 'user-123' } });
    const { user } = await renderLoginScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'hunter2');
    await user.press(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => {
      expect(mockedSaveUserId).toHaveBeenCalledWith('user-123');
    });
  });

  it('does not call ensureKeysRegistered when the user object has no id', async () => {
    mockedLogin.mockResolvedValueOnce({ token: 'tok-1', user: {} });
    const { navigation, user } = await renderLoginScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'hunter2');
    await user.press(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith('Main');
    });
    expect(mockedEnsureKeysRegistered).not.toHaveBeenCalled();
    expect(mockedSaveUserId).not.toHaveBeenCalled();
  });

  it('still navigates to Main when ensureKeysRegistered rejects', async () => {
    mockedLogin.mockResolvedValueOnce({ token: 'tok-1', user: { id: 'user-123' } });
    mockedEnsureKeysRegistered.mockRejectedValueOnce(new Error('network error'));
    const { navigation, user } = await renderLoginScreen();

    await user.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'hunter2');
    await user.press(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith('Main');
    });
  });
});
