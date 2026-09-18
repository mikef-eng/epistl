import { render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import SettingsScreen from '../src/screens/SettingsScreen';
import { ApiError, deleteAccount, uploadAvatar } from '../src/api/client';
import { clearSession, getEmail, getToken, getUserId, saveAvatarPath } from '../src/api/session';
import {
  getNotificationsEnabled,
  getThemePreference,
  saveNotificationsEnabled,
  saveThemePreference,
} from '../src/settings/preferences';
import { colorScheme } from 'nativewind';
import * as ImagePicker from 'expo-image-picker';

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
    uploadAvatar: jest.fn(),
    // `../src/components/Avatar.tsx` (issue #182) also imports
    // `API_BASE_URL` from this module -- since this whole module is
    // mocked in this file, that import would otherwise resolve to
    // `undefined` rather than the real client's computed default.
    API_BASE_URL: 'http://localhost:3000',
  };
});

jest.mock('../src/api/session', () => ({
  getEmail: jest.fn(),
  getUserId: jest.fn(),
  getToken: jest.fn(),
  saveAvatarPath: jest.fn(),
  clearSession: jest.fn(),
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('../src/settings/preferences', () => ({
  getThemePreference: jest.fn(),
  saveThemePreference: jest.fn(),
  getNotificationsEnabled: jest.fn(),
  saveNotificationsEnabled: jest.fn(),
}));

jest.mock('nativewind', () => ({
  colorScheme: { set: jest.fn() },
  // SettingsScreen's header-icon color computation reads this (added
  // alongside the Ionicons back-arrow, since `Ionicons`' `color` prop can't
  // take a NativeWind `className`) -- other screens' tests don't mock
  // `nativewind` at all and get the real `useColorScheme`, but this file
  // already mocks the whole module for `colorScheme.set`, which would
  // otherwise silently drop this named export too.
  useColorScheme: jest.fn(() => ({ colorScheme: 'light' })),
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
const mockedGetUserId = getUserId as jest.Mock;
const mockedGetToken = getToken as jest.Mock;
const mockedSaveAvatarPath = saveAvatarPath as jest.Mock;
const mockedClearSession = clearSession as jest.Mock;
const mockedGetThemePreference = getThemePreference as jest.Mock;
const mockedSaveThemePreference = saveThemePreference as jest.Mock;
const mockedGetNotificationsEnabled = getNotificationsEnabled as jest.Mock;
const mockedSaveNotificationsEnabled = saveNotificationsEnabled as jest.Mock;
const mockedColorSchemeSet = colorScheme.set as jest.Mock;
const mockedDeleteAccount = deleteAccount as jest.Mock;
const mockedUploadAvatar = uploadAvatar as jest.Mock;
const mockedRequestMediaLibraryPermissionsAsync =
  ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock;
const mockedLaunchImageLibraryAsync = ImagePicker.launchImageLibraryAsync as jest.Mock;

function crypto() {
  return jest.requireMock('../src/crypto/identity') as { [key: string]: jest.Mock };
}
function cryptoSession() {
  return jest.requireMock('../src/crypto/session') as { [key: string]: jest.Mock };
}
function storageMessages() {
  return jest.requireMock('../src/storage/messages') as { [key: string]: jest.Mock };
}

/** Jest has no native safe-area module; seed metrics so the provider
 * renders children immediately instead of waiting forever. */
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

async function renderSettingsScreen() {
  const navigation = { reset: jest.fn(), navigate: jest.fn() };
  const user = userEvent.setup();
  await render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <SettingsScreen navigation={navigation as never} route={{} as never} />
    </SafeAreaProvider>
  );
  return { navigation, user };
}

describe('SettingsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetEmail.mockResolvedValue('a@example.com');
    mockedGetUserId.mockResolvedValue('u1');
    mockedGetToken.mockResolvedValue(null);
    mockedGetThemePreference.mockResolvedValue('system');
    mockedGetNotificationsEnabled.mockResolvedValue(false);
    mockedSaveThemePreference.mockResolvedValue(undefined);
    mockedSaveNotificationsEnabled.mockResolvedValue(undefined);
    mockedSaveAvatarPath.mockResolvedValue(undefined);
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

  describe('avatar picker/upload (issue #182)', () => {
    function makeDeferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    beforeEach(() => {
      mockedRequestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
    });

    it('renders the "Change avatar" control', async () => {
      await renderSettingsScreen();

      expect(screen.getByRole('button', { name: 'Change avatar' })).toBeTruthy();
    });

    it('opens the picker, shows a loading state across the upload, and updates the avatar on success', async () => {
      mockedLaunchImageLibraryAsync.mockResolvedValueOnce({
        canceled: false,
        assets: [{ uri: 'file:///tmp/photo.jpg' }],
      });
      const deferred = makeDeferred<{ image: string }>();
      mockedUploadAvatar.mockReturnValueOnce(deferred.promise);
      const { user } = await renderSettingsScreen();

      await user.press(screen.getByRole('button', { name: 'Change avatar' }));

      await waitFor(() => {
        expect(mockedLaunchImageLibraryAsync).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(mockedUploadAvatar).toHaveBeenCalledWith('file:///tmp/photo.jpg');
      });
      await waitFor(() => {
        expect(screen.getByText('Uploading...')).toBeTruthy();
      });

      deferred.resolve({ image: '/api/avatar/u1' });

      await waitFor(() => {
        expect(mockedSaveAvatarPath).toHaveBeenCalledWith('/api/avatar/u1');
      });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Change avatar' })).toBeTruthy();
      });
      expect(screen.queryByText('Uploading...')).toBeNull();
    });

    it('does nothing when the user cancels the picker', async () => {
      mockedLaunchImageLibraryAsync.mockResolvedValueOnce({ canceled: true, assets: null });
      const { user } = await renderSettingsScreen();

      await user.press(screen.getByRole('button', { name: 'Change avatar' }));

      await waitFor(() => {
        expect(mockedLaunchImageLibraryAsync).toHaveBeenCalledTimes(1);
      });
      expect(mockedUploadAvatar).not.toHaveBeenCalled();
    });

    it('shows an inline error and does not call the picker when photo library permission is denied', async () => {
      mockedRequestMediaLibraryPermissionsAsync.mockResolvedValueOnce({ granted: false });
      const { user } = await renderSettingsScreen();

      await user.press(screen.getByRole('button', { name: 'Change avatar' }));

      await waitFor(() => {
        expect(screen.getByText('Permission to access photos is required')).toBeTruthy();
      });
      expect(mockedLaunchImageLibraryAsync).not.toHaveBeenCalled();
      expect(mockedUploadAvatar).not.toHaveBeenCalled();
    });

    it('shows an inline error and clears the loading state when uploadAvatar rejects', async () => {
      mockedLaunchImageLibraryAsync.mockResolvedValueOnce({
        canceled: false,
        assets: [{ uri: 'file:///tmp/photo.jpg' }],
      });
      mockedUploadAvatar.mockRejectedValueOnce(new ApiError('file_too_large', 400));
      const { user } = await renderSettingsScreen();

      await user.press(screen.getByRole('button', { name: 'Change avatar' }));

      await waitFor(() => {
        expect(screen.getByText('file_too_large')).toBeTruthy();
      });
      expect(screen.queryByText('Uploading...')).toBeNull();
      expect(mockedSaveAvatarPath).not.toHaveBeenCalled();
    });
  });
});
