import * as SecureStore from 'expo-secure-store';

import {
  saveToken,
  getToken,
  clearToken,
  saveUserId,
  getUserId,
  SESSION_TOKEN_KEY,
  SESSION_USER_ID_KEY,
} from '../session';

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

describe('session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('saveToken persists the token under the session key', async () => {
    await saveToken('token-123');

    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(SESSION_TOKEN_KEY, 'token-123');
  });

  it('getToken reads the token from secure storage', async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce('token-abc');

    await expect(getToken()).resolves.toBe('token-abc');
    expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith(SESSION_TOKEN_KEY);
  });

  it('getToken resolves null when no token is stored', async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce(null);

    await expect(getToken()).resolves.toBeNull();
  });

  it('clearToken removes the token from secure storage', async () => {
    await clearToken();

    expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith(SESSION_TOKEN_KEY);
  });

  it('saveUserId persists the user id under its own session key', async () => {
    await saveUserId('user-123');

    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(SESSION_USER_ID_KEY, 'user-123');
  });

  it('getUserId reads the user id from secure storage', async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce('user-abc');

    await expect(getUserId()).resolves.toBe('user-abc');
    expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith(SESSION_USER_ID_KEY);
  });

  it('getUserId resolves null when no user id is stored', async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce(null);

    await expect(getUserId()).resolves.toBeNull();
  });
});
