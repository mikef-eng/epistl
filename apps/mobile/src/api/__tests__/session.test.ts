import * as SecureStore from 'expo-secure-store';

import { saveToken, getToken, clearToken, SESSION_TOKEN_KEY } from '../session';

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
});
