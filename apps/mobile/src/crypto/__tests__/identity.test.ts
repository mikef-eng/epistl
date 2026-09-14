import 'react-native-get-random-values';

import * as SecureStore from 'expo-secure-store';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { clearIdentity, ensureLocalIdentity, generateIdentity, PREKEY_SIGNATURE_CONTEXT } from '../identity';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

const mockSecureStore = SecureStore as unknown as {
  __store: Map<string, string>;
  setItemAsync: jest.Mock;
  getItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
};

describe('generateIdentity', () => {
  it('produces keys of the expected fixed lengths', () => {
    const identity = generateIdentity();

    expect(identity.kyberPublicKey.length).toBe(1184);
    expect(identity.kyberSecretKey.length).toBe(2400);
    expect(identity.dilithiumPublicKey.length).toBe(1952);
    expect(identity.dilithiumSecretKey.length).toBe(4032);
    expect(identity.x25519PublicKey.length).toBe(32);
    expect(identity.x25519SecretKey.length).toBe(32);
    expect(identity.prekeySignature.length).toBe(3309);
  });

  it('produces a prekeySignature that verifies against the domain-separated message', () => {
    const identity = generateIdentity();

    const message = concatBytes(
      utf8ToBytes(PREKEY_SIGNATURE_CONTEXT),
      identity.x25519PublicKey,
      identity.kyberPublicKey
    );

    expect(
      ml_dsa65.verify(identity.prekeySignature, message, identity.dilithiumPublicKey)
    ).toBe(true);
  });
});

describe('ensureLocalIdentity', () => {
  beforeEach(() => {
    mockSecureStore.__store.clear();
    jest.clearAllMocks();
  });

  it('persists a freshly generated identity on first call', async () => {
    const identity = await ensureLocalIdentity();

    expect(identity.kyberPublicKey.length).toBe(1184);
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
      'epistl.kyber_secret_key',
      expect.any(String)
    );
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
      'epistl.kyber_public_key',
      expect.any(String)
    );
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
      'epistl.dilithium_secret_key',
      expect.any(String)
    );
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
      'epistl.dilithium_public_key',
      expect.any(String)
    );
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
      'epistl.x25519_secret_key',
      expect.any(String)
    );
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
      'epistl.x25519_public_key',
      expect.any(String)
    );

    const message = concatBytes(
      utf8ToBytes(PREKEY_SIGNATURE_CONTEXT),
      identity.x25519PublicKey,
      identity.kyberPublicKey
    );
    expect(
      ml_dsa65.verify(identity.prekeySignature, message, identity.dilithiumPublicKey)
    ).toBe(true);
  });

  it('returns the identical stored identity on a second call, without regenerating', async () => {
    const first = await ensureLocalIdentity();
    mockSecureStore.setItemAsync.mockClear();

    const second = await ensureLocalIdentity();

    expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(second.kyberPublicKey).toEqual(first.kyberPublicKey);
    expect(second.kyberSecretKey).toEqual(first.kyberSecretKey);
    expect(second.dilithiumPublicKey).toEqual(first.dilithiumPublicKey);
    expect(second.dilithiumSecretKey).toEqual(first.dilithiumSecretKey);
    expect(second.x25519PublicKey).toEqual(first.x25519PublicKey);
    expect(second.x25519SecretKey).toEqual(first.x25519SecretKey);

    const message = concatBytes(
      utf8ToBytes(PREKEY_SIGNATURE_CONTEXT),
      second.x25519PublicKey,
      second.kyberPublicKey
    );
    expect(
      ml_dsa65.verify(second.prekeySignature, message, second.dilithiumPublicKey)
    ).toBe(true);
  });

  it('returns the same identity to concurrent callers and only persists one identity worth of keys', async () => {
    const [a, b] = await Promise.all([ensureLocalIdentity(), ensureLocalIdentity()]);

    expect(a.kyberPublicKey).toEqual(b.kyberPublicKey);
    expect(a.kyberSecretKey).toEqual(b.kyberSecretKey);
    expect(a.dilithiumPublicKey).toEqual(b.dilithiumPublicKey);
    expect(a.dilithiumSecretKey).toEqual(b.dilithiumSecretKey);
    expect(a.x25519PublicKey).toEqual(b.x25519PublicKey);
    expect(a.x25519SecretKey).toEqual(b.x25519SecretKey);

    expect(mockSecureStore.setItemAsync).toHaveBeenCalledTimes(6);
  });

  it('does not let the in-flight cache leak into a later, independent call', async () => {
    const first = await ensureLocalIdentity();
    mockSecureStore.setItemAsync.mockClear();
    mockSecureStore.getItemAsync.mockClear();

    const second = await ensureLocalIdentity();

    expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(second.kyberPublicKey).toEqual(first.kyberPublicKey);
  });

  it('clears the in-flight cache on failure so a later call retries instead of failing forever', async () => {
    mockSecureStore.setItemAsync.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    await expect(ensureLocalIdentity()).rejects.toThrow('boom');

    const identity = await ensureLocalIdentity();

    expect(identity.kyberPublicKey.length).toBe(1184);
    expect(mockSecureStore.setItemAsync).toHaveBeenCalled();
  });
});

describe('clearIdentity', () => {
  beforeEach(() => {
    mockSecureStore.__store.clear();
    jest.clearAllMocks();
  });

  it('deletes all six stored key fields', async () => {
    await ensureLocalIdentity();

    await clearIdentity();

    expect(mockSecureStore.__store.has('epistl.kyber_secret_key')).toBe(false);
    expect(mockSecureStore.__store.has('epistl.kyber_public_key')).toBe(false);
    expect(mockSecureStore.__store.has('epistl.dilithium_secret_key')).toBe(false);
    expect(mockSecureStore.__store.has('epistl.dilithium_public_key')).toBe(false);
    expect(mockSecureStore.__store.has('epistl.x25519_secret_key')).toBe(false);
    expect(mockSecureStore.__store.has('epistl.x25519_public_key')).toBe(false);
  });

  it('leaves no stored identity behind, so a later call generates a brand-new one', async () => {
    const first = await ensureLocalIdentity();

    await clearIdentity();
    const second = await ensureLocalIdentity();

    expect(second.kyberPublicKey).not.toEqual(first.kyberPublicKey);
  });
});
