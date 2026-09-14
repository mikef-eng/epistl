import { render, screen, userEvent, waitFor } from '@testing-library/react-native';

import SettingsScreen from '../src/screens/SettingsScreen';
import { ApiError, deleteAccount } from '../src/api/client';
import { clearSession, getEmail } from '../src/api/session';
import {
  getNotificationsEnabled,
  getThemePreference,
  saveNotificationsEnabled,
  saveThemePreference,
} from '../src/settings/preferences';
import { colorScheme } from 'nativewind';

jest.mock('../src/api/client', () => {
  class MockApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number) {
      super(code);
      this.code = code;
      this.status = status;
    }
  }
  return {
    ApiError: MockApiError,
    deleteAccount: jest.fn(),
  };
});

jest.mock('../src/api/session', () => ({
  getEmail: jest.fn(),
  clearSession: jest.fn(),
}));

jest.mock('../src/settings/preferences', () => ({
  getThemePreference: jest.fn(),
  saveThemePreference: jest.fn(),
  getNotificationsEnabled: jest.fn(),
  saveNotificationsEnabled: jest.fn(),
}));

jest.mock('nativewind', () => ({
  colorScheme: { set: jest.fn() },
}));

// Issue #125's log-out flow must never touch crypto identity, ratchet
// sessions, or local chat history -- those are device-local and
// session-independent, per `../src/api/session.ts`'s `clearSession` doc
// comment. Issue #92's delete-account flow, by contrast, must call all
// three on success (and none of them on failure) -- both are exercised
// below against these same mocks.
jest.mock('../src/crypto/identity', () => ({
  ensureLocalIdentity: jest.fn(),
  clearIdentity: jest.fn(),
}));
jest.mock('../src/crypto/session', () => ({
  loadSession: jest.fn(),
  saveSession: jest.fn(),
  clearAllSessions: jest.fn(),
}));
jest.mock('../src/storage/messages', () => ({
  getMessages: jest.fn(),
  saveMessage: jest.fn(),
  clearAllMessages: jest.fn(),
}));

const mockedGetEmail = getEmail as jest.Mock;
const mockedClearSession = clearSession as jest.Mock;
const mockedGetThemePreference = getThemePreference as jest.Mock;
const mockedSaveThemePreference = saveThemePreference as jest.Mock;
const mockedGetNotificationsEnabled = getNotificationsEnabled as jest.Mock;
const mockedSaveNotificationsEnabled = saveNotificationsEnabled as jest.Mock;
const mockedColorSchemeSet = colorScheme.set as jest.Mock;
const mockedDeleteAccount = deleteAccount as jest.Mock;

function crypto() {
  return jest.requireMock('../src/crypto/identity') as { [key: string]: jest.Mock };
}
function cryptoSession() {
  return jest.requireMock('../src/crypto/session') as { [key: string]: jest.Mock };
}
function storageMessages() {
  return jest.requireMock('../src/storage/messages') as { [key: string]: jest.Mock };
}

async function renderSettingsScreen() {
  const navigation = { reset: jest.fn(), navigate: jest.fn() };
  const user = userEvent.setup();
  await render(<SettingsScreen navigation={navigation as never} route={{} as never} />);
  return { navigation, user };
}

describe('SettingsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetEmail.mockResolvedValue('a@example.com');
    mockedGetThemePreference.mockResolvedValue('system');
    mockedGetNotificationsEnabled.mockResolvedValue(false);
    mockedSaveThemePreference.mockResolvedValue(undefined);
    mockedSaveNotificationsEnabled.mockResolvedValue(undefined);
    mockedClearSession.mockResolvedValue(undefined);
    mockedDeleteAccount.mockResolvedValue(undefined);
    crypto().clearIdentity.mockResolvedValue(undefined);
    cryptoSession().clearAllSessions.mockResolvedValue(undefined);
    storageMessages().clearAllMessages.mockResolvedValue(undefined);
  });

  it('renders dark: variants on its title, sections, and account email text', async () => {
    await renderSettingsScreen();

    await waitFor(() => {
      expect(screen.getByText('a@example.com')).toBeTruthy();
    });

    expect(screen.getByText('Settings').props.className).toContain('dark:text-white');
    expect(screen.getByText('a@example.com').props.className).toContain('dark:text-white');
  });

  describe('appearance', () => {
    it('persists and applies "light" when selected', async () => {
      const { user } = await renderSettingsScreen();

      await user.press(screen.getByRole('button', { name: 'Light' }));

      await waitFor(() => {
        expect(mockedSaveThemePreference).toHaveBeenCalledWith('light');
      });
      expect(mockedColorSchemeSet).toHaveBeenCalledWith('light');
    });

    it('persists and applies "dark" when selected', async () => {
      const { user } = await renderSettingsScreen();

      await user.press(screen.getByRole('button', { name: 'Dark' }));

      await waitFor(() => {
        expect(mockedSaveThemePreference).toHaveBeenCalledWith('dark');
      });
      expect(mockedColorSchemeSet).toHaveBeenCalledWith('dark');
    });

    it('persists and applies "system" when selected', async () => {
      const { user } = await renderSettingsScreen();

      await user.press(screen.getByRole('button', { name: 'System' }));

      await waitFor(() => {
        expect(mockedSaveThemePreference).toHaveBeenCalledWith('system');
      });
      expect(mockedColorSchemeSet).toHaveBeenCalledWith('system');
    });
  });

  describe('account info', () => {
    it('displays the persisted email fetched on mount', async () => {
      mockedGetEmail.mockResolvedValueOnce('someone@example.com');

      await renderSettingsScreen();

      await waitFor(() => {
        expect(screen.getByText('someone@example.com')).toBeTruthy();
      });
    });
  });

  describe('notifications toggle', () => {
    it('persists true via preferences.ts without triggering any other behavior', async () => {
      mockedGetNotificationsEnabled.mockResolvedValueOnce(false);
      const { user } = await renderSettingsScreen();

      await waitFor(() => {
        expect(mockedGetNotificationsEnabled).toHaveBeenCalled();
      });

      await user.press(screen.getByRole('switch', { name: 'Notifications' }));

      await waitFor(() => {
        expect(mockedSaveNotificationsEnabled).toHaveBeenCalledWith(true);
      });
      expect(mockedClearSession).not.toHaveBeenCalled();
      expect(mockedColorSchemeSet).not.toHaveBeenCalled();
    });

    it('shows a "coming soon" label under the toggle', async () => {
      await renderSettingsScreen();

      await waitFor(() => {
        expect(screen.getByText(/coming soon/i)).toBeTruthy();
      });
    });
  });

  describe('log out', () => {
    it('calls clearSession then resets navigation to Login', async () => {
      const { navigation, user } = await renderSettingsScreen();

      await user.press(screen.getByRole('button', { name: 'Log out' }));

      await waitFor(() => {
        expect(mockedClearSession).toHaveBeenCalledTimes(1);
      });
      expect(navigation.reset).toHaveBeenCalledWith({
        index: 0,
        routes: [{ name: 'Login' }],
      });
    });

    it('does not touch crypto/identity, crypto/session, or storage/messages', async () => {
      const { user } = await renderSettingsScreen();

      await user.press(screen.getByRole('button', { name: 'Log out' }));

      await waitFor(() => {
        expect(mockedClearSession).toHaveBeenCalledTimes(1);
      });

      for (const fn of Object.values(crypto())) {
        expect(fn).not.toHaveBeenCalled();
      }
      for (const fn of Object.values(cryptoSession())) {
        expect(fn).not.toHaveBeenCalled();
      }
      for (const fn of Object.values(storageMessages())) {
        expect(fn).not.toHaveBeenCalled();
      }
    });
  });

  describe('delete account', () => {
    it('requires confirmation before calling the endpoint -- pressing "Delete account" alone does not call it', async () => {
      const { user } = await renderSettingsScreen();

      await user.press(screen.getByRole('button', { name: 'Delete account' }));

      expect(mockedDeleteAccount).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Confirm account deletion')).toBeTruthy();
    });

    it('keeps "Confirm delete" disabled (and does not call the endpoint) until the typed text matches the account email', async () => {
      mockedGetEmail.mockResolvedValue('a@example.com');
      const { user } = await renderSettingsScreen();
      await waitFor(() => expect(screen.getByText('a@example.com')).toBeTruthy());

      await user.press(screen.getByRole('button', { name: 'Delete account' }));
      await user.type(screen.getByLabelText('Confirm account deletion'), 'not-the-email');
      await user.press(screen.getByRole('button', { name: 'Confirm delete' }));

      expect(mockedDeleteAccount).not.toHaveBeenCalled();
    });

    it('cancels without calling the endpoint and hides the confirmation step', async () => {
      const { user } = await renderSettingsScreen();

      await user.press(screen.getByRole('button', { name: 'Delete account' }));
      await user.press(screen.getByRole('button', { name: 'Cancel' }));

      expect(mockedDeleteAccount).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Confirm account deletion')).toBeNull();
    });

    it('on confirmed success: calls deleteAccount, wipes session/identity/sessions/messages, and resets nav to Login', async () => {
      mockedGetEmail.mockResolvedValue('a@example.com');
      const { navigation, user } = await renderSettingsScreen();
      await waitFor(() => expect(screen.getByText('a@example.com')).toBeTruthy());

      await user.press(screen.getByRole('button', { name: 'Delete account' }));
      await user.type(screen.getByLabelText('Confirm account deletion'), 'a@example.com');
      await user.press(screen.getByRole('button', { name: 'Confirm delete' }));

      await waitFor(() => {
        expect(mockedDeleteAccount).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(navigation.reset).toHaveBeenCalledWith({
          index: 0,
          routes: [{ name: 'Login' }],
        });
      });
      expect(mockedClearSession).toHaveBeenCalledTimes(1);
      expect(crypto().clearIdentity).toHaveBeenCalledTimes(1);
      expect(cryptoSession().clearAllSessions).toHaveBeenCalledTimes(1);
      expect(storageMessages().clearAllMessages).toHaveBeenCalledTimes(1);
    });

    it('on failure: shows an inline error and leaves session/identity/sessions/messages untouched, without resetting nav', async () => {
      mockedGetEmail.mockResolvedValue('a@example.com');
      mockedDeleteAccount.mockRejectedValueOnce(new ApiError('internal_error', 500));
      const { navigation, user } = await renderSettingsScreen();
      await waitFor(() => expect(screen.getByText('a@example.com')).toBeTruthy());

      await user.press(screen.getByRole('button', { name: 'Delete account' }));
      await user.type(screen.getByLabelText('Confirm account deletion'), 'a@example.com');
      await user.press(screen.getByRole('button', { name: 'Confirm delete' }));

      await waitFor(() => {
        expect(screen.getByText('internal_error')).toBeTruthy();
      });
      expect(mockedClearSession).not.toHaveBeenCalled();
      for (const fn of Object.values(crypto())) {
        expect(fn).not.toHaveBeenCalled();
      }
      for (const fn of Object.values(cryptoSession())) {
        expect(fn).not.toHaveBeenCalled();
      }
      for (const fn of Object.values(storageMessages())) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(navigation.reset).not.toHaveBeenCalled();
    });
  });
});
