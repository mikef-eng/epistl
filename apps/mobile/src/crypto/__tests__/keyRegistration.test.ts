import * as SecureStore from 'expo-secure-store';

import { registerKeys } from '../../api/client';
import { bytesToBase64 } from '../../utils/base64';
import { ensureLocalIdentity } from '../identity';
import { ensureKeysRegistered, KEYS_UPLOADED_FOR_USER_ID_KEY } from '../keyRegistration';

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('../../api/client', () => ({
  registerKeys: jest.fn(),
}));

jest.mock('../identity', () => ({
  ensureLocalIdentity: jest.fn(),
}));

const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;
const mockRegisterKeys = registerKeys as jest.Mock;
const mockEnsureLocalIdentity = ensureLocalIdentity as jest.Mock;

const identity = {
  x25519PublicKey: new Uint8Array([1]),
  kyberPublicKey: new Uint8Array([2]),
  dilithiumPublicKey: new Uint8Array([3]),
  prekeySignature: new Uint8Array([4]),
};

describe('ensureKeysRegistered', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureLocalIdentity.mockResolvedValue(identity);
  });

  it('skips registerKeys when the marker already matches the user id', async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce('user-1');

    await ensureKeysRegistered('user-1');

    expect(mockRegisterKeys).not.toHaveBeenCalled();
  });

  it('generates/loads the local identity and uploads it when the marker does not match', async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce('some-other-user');

    await ensureKeysRegistered('user-1');

    expect(mockEnsureLocalIdentity).toHaveBeenCalled();
    expect(mockRegisterKeys).toHaveBeenCalledWith(
      bytesToBase64(identity.x25519PublicKey),
      bytesToBase64(identity.kyberPublicKey),
      bytesToBase64(identity.dilithiumPublicKey),
      bytesToBase64(identity.prekeySignature)
    );
  });

  it('uploads when no marker has ever been set', async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce(null);

    await ensureKeysRegistered('user-1');

    expect(mockRegisterKeys).toHaveBeenCalled();
  });

  it('sets the marker to the user id on successful upload', async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce(null);
    mockRegisterKeys.mockResolvedValueOnce(undefined);

    await ensureKeysRegistered('user-1');

    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
      KEYS_UPLOADED_FOR_USER_ID_KEY,
      'user-1'
    );
  });

  it('does not set the marker and does not throw when registerKeys fails', async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce(null);
    mockRegisterKeys.mockRejectedValueOnce(new Error('network error'));

    await expect(ensureKeysRegistered('user-1')).resolves.toBeUndefined();

    expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('does not throw when ensureLocalIdentity fails', async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce(null);
    mockEnsureLocalIdentity.mockRejectedValueOnce(new Error('storage error'));

    await expect(ensureKeysRegistered('user-1')).resolves.toBeUndefined();

    expect(mockRegisterKeys).not.toHaveBeenCalled();
    expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
  });
});
