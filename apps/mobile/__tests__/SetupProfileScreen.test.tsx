import { render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';

import SetupProfileScreen from '../src/screens/SetupProfileScreen';
import { ApiError, UsernameTakenError, signup, uploadAvatar } from '../src/api/client';
import { saveAvatarPath, saveUserId } from '../src/api/session';
import { ensureKeysRegistered } from '../src/crypto/keyRegistration';

jest.mock('../src/api/client', () => {
  class MockApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number) {
      super(code);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
    }
  }
  class MockUsernameTakenError extends MockApiError {
    constructor() {
      super('username_taken', 409);
      this.name = 'UsernameTakenError';
    }
  }
  return {
    ApiError: MockApiError,
    UsernameTakenError: MockUsernameTakenError,
    signup: jest.fn(),
    uploadAvatar: jest.fn(),
  };
});

jest.mock('../src/api/session', () => ({
  saveUserId: jest.fn(),
  saveAvatarPath: jest.fn(),
}));

jest.mock('../src/crypto/keyRegistration', () => ({
  ensureKeysRegistered: jest.fn(),
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

const mockedSignup = signup as jest.Mock;
const mockedUploadAvatar = uploadAvatar as jest.Mock;
const mockedSaveUserId = saveUserId as jest.Mock;
const mockedSaveAvatarPath = saveAvatarPath as jest.Mock;
const mockedEnsureKeysRegistered = ensureKeysRegistered as jest.Mock;
const mockedRequestPermission = ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock;
const mockedLaunch = ImagePicker.launchImageLibraryAsync as jest.Mock;

const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

async function renderSetupProfileScreen() {
  const navigation = { replace: jest.fn(), goBack: jest.fn() };
  const route = { params: { email: 'a@example.com', password: 'hunter2' } };
  const user = userEvent.setup();
  await render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <SetupProfileScreen navigation={navigation as never} route={route as never} />
    </SafeAreaProvider>
  );
  return { navigation, user };
}

describe('SetupProfileScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSaveUserId.mockResolvedValue(undefined);
    mockedSaveAvatarPath.mockResolvedValue(undefined);
    mockedRequestPermission.mockResolvedValue({ granted: true });
    mockedEnsureKeysRegistered.mockResolvedValue(undefined);
  });

  it('renders dark: variants on its background and username field', async () => {
    await renderSetupProfileScreen();

    expect(screen.getByPlaceholderText('Username').props.className).toContain('dark:text-white');
  });

  it('disables submit until a username is entered', async () => {
    await renderSetupProfileScreen();

    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();
  });

  it('shows an inline format error and does not call signup for an invalid username', async () => {
    const { user } = await renderSetupProfileScreen();

    await user.type(screen.getByPlaceholderText('Username'), 'ab');
    await user.press(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(screen.getByText(/3-30 characters/i)).toBeTruthy();
    });
    expect(mockedSignup).not.toHaveBeenCalled();
  });

  it('submits with the route email/password and the entered username, then navigates to Main on success', async () => {
    mockedSignup.mockResolvedValueOnce({ token: 'tok-1', user: { id: 'user-1' } });
    const { navigation, user } = await renderSetupProfileScreen();

    await user.type(screen.getByPlaceholderText('Username'), 'alice');
    await user.press(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(mockedSignup).toHaveBeenCalledWith('a@example.com', 'hunter2', 'alice');
    });
    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith('Main');
    });
    expect(mockedSaveUserId).toHaveBeenCalledWith('user-1');
    expect(mockedEnsureKeysRegistered).toHaveBeenCalledWith('user-1');
  });

  it('shows a specific "already taken" inline error on 409 and does not navigate away, keeping the form intact', async () => {
    mockedSignup.mockRejectedValueOnce(new UsernameTakenError());
    const { navigation, user } = await renderSetupProfileScreen();

    await user.type(screen.getByPlaceholderText('Username'), 'taken_name');
    await user.press(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(screen.getByText(/already taken/i)).toBeTruthy();
    });
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Username').props.value).toBe('taken_name');
  });

  it('shows the ApiError message inline on a non-409 signup failure', async () => {
    mockedSignup.mockRejectedValueOnce(new ApiError('internal_error', 500));
    const { user } = await renderSetupProfileScreen();

    await user.type(screen.getByPlaceholderText('Username'), 'alice');
    await user.press(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(screen.getByText('internal_error')).toBeTruthy();
    });
  });

  it('lets the user submit and proceed without picking an avatar', async () => {
    mockedSignup.mockResolvedValueOnce({ token: 'tok-1', user: { id: 'user-1' } });
    const { navigation, user } = await renderSetupProfileScreen();

    await user.type(screen.getByPlaceholderText('Username'), 'alice');
    await user.press(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith('Main');
    });
    expect(mockedUploadAvatar).not.toHaveBeenCalled();
  });

  it('uploads a picked avatar after a successful signup and still navigates to Main', async () => {
    mockedLaunch.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tmp/photo.jpg' }],
    });
    mockedSignup.mockResolvedValueOnce({ token: 'tok-1', user: { id: 'user-1' } });
    mockedUploadAvatar.mockResolvedValueOnce({ image: '/api/avatar/user-1' });
    const { navigation, user } = await renderSetupProfileScreen();

    await user.press(screen.getByRole('button', { name: 'Add a photo' }));
    await waitFor(() => {
      expect(mockedLaunch).toHaveBeenCalledTimes(1);
    });

    await user.type(screen.getByPlaceholderText('Username'), 'alice');
    await user.press(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(mockedUploadAvatar).toHaveBeenCalledWith('file:///tmp/photo.jpg');
    });
    expect(mockedSaveAvatarPath).toHaveBeenCalledWith('/api/avatar/user-1');
    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith('Main');
    });
  });

  it('does not call uploadAvatar until the account is created via signup', async () => {
    mockedLaunch.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tmp/photo.jpg' }],
    });
    const { user } = await renderSetupProfileScreen();

    await user.press(screen.getByRole('button', { name: 'Add a photo' }));

    await waitFor(() => {
      expect(mockedLaunch).toHaveBeenCalledTimes(1);
    });
    expect(mockedUploadAvatar).not.toHaveBeenCalled();
  });

  it('shows an inline error but still navigates to Main when the post-signup avatar upload fails', async () => {
    mockedLaunch.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tmp/photo.jpg' }],
    });
    mockedSignup.mockResolvedValueOnce({ token: 'tok-1', user: { id: 'user-1' } });
    mockedUploadAvatar.mockRejectedValueOnce(new ApiError('file_too_large', 400));
    const { navigation, user } = await renderSetupProfileScreen();

    await user.press(screen.getByRole('button', { name: 'Add a photo' }));
    await waitFor(() => {
      expect(mockedLaunch).toHaveBeenCalledTimes(1);
    });

    await user.type(screen.getByPlaceholderText('Username'), 'alice');
    await user.press(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(screen.getByText('file_too_large')).toBeTruthy();
    });
    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith('Main');
    });
  });

  it('shows an inline error and does not open the picker when photo library permission is denied', async () => {
    mockedRequestPermission.mockResolvedValueOnce({ granted: false });
    const { user } = await renderSetupProfileScreen();

    await user.press(screen.getByRole('button', { name: 'Add a photo' }));

    await waitFor(() => {
      expect(screen.getByText('Permission to access photos is required')).toBeTruthy();
    });
    expect(mockedLaunch).not.toHaveBeenCalled();
  });

  it('does nothing when the user cancels the avatar picker', async () => {
    mockedLaunch.mockResolvedValueOnce({ canceled: true, assets: null });
    const { user } = await renderSetupProfileScreen();

    await user.press(screen.getByRole('button', { name: 'Add a photo' }));

    await waitFor(() => {
      expect(mockedLaunch).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('button', { name: 'Add a photo' })).toBeTruthy();
  });

  it('goes back to Login when the back button is pressed', async () => {
    const { navigation, user } = await renderSetupProfileScreen();

    await user.press(screen.getByLabelText('Back'));

    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });
});
