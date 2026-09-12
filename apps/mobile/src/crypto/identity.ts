/**
 * On-device identity keypair generation and secure storage.
 *
 * Generates and durably persists one ML-KEM-768 (Kyber) keypair, one
 * ML-DSA-65 (Dilithium) keypair, and one X25519 keypair per device, plus a
 * Dilithium signature binding the X25519 and Kyber public keys together
 * (the "prekey signature"). Private keys never leave `expo-secure-store`.
 *
 * This module only generates and stores key material — it does not perform
 * any ECDH, KEM encapsulation, AEAD, or handshake logic (see issue #38), and
 * it is not yet wired into any screen or uploaded to the server (see issue
 * #37).
 */
import * as SecureStore from 'expo-secure-store';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { x25519 } from '@noble/curves/ed25519.js';

import { base64ToBytes, bytesToBase64 } from '../utils/base64';

/**
 * Domain-separation prefix for the prekey signature, so a Dilithium
 * signature produced for this purpose can never be replayed/confused with a
 * signature produced for some other purpose.
 */
export const PREKEY_SIGNATURE_CONTEXT = 'epistl/v1/prekey/';

export const KYBER_SECRET_KEY_STORAGE_KEY = 'epistl.kyber_secret_key';
export const KYBER_PUBLIC_KEY_STORAGE_KEY = 'epistl.kyber_public_key';
export const DILITHIUM_SECRET_KEY_STORAGE_KEY = 'epistl.dilithium_secret_key';
export const DILITHIUM_PUBLIC_KEY_STORAGE_KEY = 'epistl.dilithium_public_key';
export const X25519_SECRET_KEY_STORAGE_KEY = 'epistl.x25519_secret_key';
export const X25519_PUBLIC_KEY_STORAGE_KEY = 'epistl.x25519_public_key';

/** The six raw key fields that make up one device's identity. */
export type IdentityKeys = {
  kyberPublicKey: Uint8Array;
  kyberSecretKey: Uint8Array;
  dilithiumPublicKey: Uint8Array;
  dilithiumSecretKey: Uint8Array;
  x25519PublicKey: Uint8Array;
  x25519SecretKey: Uint8Array;
};

/** An identity's six raw keys plus the derived prekey signature. */
export type Identity = IdentityKeys & {
  prekeySignature: Uint8Array;
};

function prekeyMessage(x25519PublicKey: Uint8Array, kyberPublicKey: Uint8Array): Uint8Array {
  return concatBytes(utf8ToBytes(PREKEY_SIGNATURE_CONTEXT), x25519PublicKey, kyberPublicKey);
}

function signPrekey(keys: IdentityKeys): Uint8Array {
  return ml_dsa65.sign(
    prekeyMessage(keys.x25519PublicKey, keys.kyberPublicKey),
    keys.dilithiumSecretKey
  );
}

/**
 * Generates a brand-new identity: a Kyber keypair, a Dilithium keypair, an
 * X25519 keypair, and a Dilithium signature over the X25519 and Kyber
 * public keys. Does not persist anything — see `ensureLocalIdentity` for
 * the persisted, idempotent variant.
 */
export function generateIdentity(): Identity {
  const kyber = ml_kem768.keygen();
  const dilithium = ml_dsa65.keygen();
  const x25519Keys = x25519.keygen();

  const keys: IdentityKeys = {
    kyberPublicKey: kyber.publicKey,
    kyberSecretKey: kyber.secretKey,
    dilithiumPublicKey: dilithium.publicKey,
    dilithiumSecretKey: dilithium.secretKey,
    x25519PublicKey: x25519Keys.publicKey,
    x25519SecretKey: x25519Keys.secretKey,
  };

  return {
    ...keys,
    prekeySignature: signPrekey(keys),
  };
}

async function loadStoredKeys(): Promise<IdentityKeys | null> {
  const [
    kyberSecretKeyB64,
    kyberPublicKeyB64,
    dilithiumSecretKeyB64,
    dilithiumPublicKeyB64,
    x25519SecretKeyB64,
    x25519PublicKeyB64,
  ] = await Promise.all([
    SecureStore.getItemAsync(KYBER_SECRET_KEY_STORAGE_KEY),
    SecureStore.getItemAsync(KYBER_PUBLIC_KEY_STORAGE_KEY),
    SecureStore.getItemAsync(DILITHIUM_SECRET_KEY_STORAGE_KEY),
    SecureStore.getItemAsync(DILITHIUM_PUBLIC_KEY_STORAGE_KEY),
    SecureStore.getItemAsync(X25519_SECRET_KEY_STORAGE_KEY),
    SecureStore.getItemAsync(X25519_PUBLIC_KEY_STORAGE_KEY),
  ]);

  if (
    kyberSecretKeyB64 === null ||
    kyberPublicKeyB64 === null ||
    dilithiumSecretKeyB64 === null ||
    dilithiumPublicKeyB64 === null ||
    x25519SecretKeyB64 === null ||
    x25519PublicKeyB64 === null
  ) {
    return null;
  }

  return {
    kyberSecretKey: base64ToBytes(kyberSecretKeyB64),
    kyberPublicKey: base64ToBytes(kyberPublicKeyB64),
    dilithiumSecretKey: base64ToBytes(dilithiumSecretKeyB64),
    dilithiumPublicKey: base64ToBytes(dilithiumPublicKeyB64),
    x25519SecretKey: base64ToBytes(x25519SecretKeyB64),
    x25519PublicKey: base64ToBytes(x25519PublicKeyB64),
  };
}

async function persistKeys(keys: IdentityKeys): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KYBER_SECRET_KEY_STORAGE_KEY, bytesToBase64(keys.kyberSecretKey)),
    SecureStore.setItemAsync(KYBER_PUBLIC_KEY_STORAGE_KEY, bytesToBase64(keys.kyberPublicKey)),
    SecureStore.setItemAsync(
      DILITHIUM_SECRET_KEY_STORAGE_KEY,
      bytesToBase64(keys.dilithiumSecretKey)
    ),
    SecureStore.setItemAsync(
      DILITHIUM_PUBLIC_KEY_STORAGE_KEY,
      bytesToBase64(keys.dilithiumPublicKey)
    ),
    SecureStore.setItemAsync(X25519_SECRET_KEY_STORAGE_KEY, bytesToBase64(keys.x25519SecretKey)),
    SecureStore.setItemAsync(X25519_PUBLIC_KEY_STORAGE_KEY, bytesToBase64(keys.x25519PublicKey)),
  ]);
}

/**
 * In-flight promise for an `ensureLocalIdentity()` call that has not yet
 * settled. Guards against concurrent invocations (e.g. two screens both
 * calling it during app startup) independently seeing no stored keys, each
 * generating their own identity, and interleaving their `persistKeys()`
 * writes into a mixed/inconsistent on-device identity. Cleared once the
 * call settles, whether it succeeds or fails, so a later independent call
 * always re-checks storage and a failed call can be retried rather than
 * permanently stuck.
 */
let inFlight: Promise<Identity> | null = null;

async function ensureLocalIdentityUncached(): Promise<Identity> {
  const storedKeys = await loadStoredKeys();

  if (storedKeys !== null) {
    return {
      ...storedKeys,
      prekeySignature: signPrekey(storedKeys),
    };
  }

  const identity = generateIdentity();
  await persistKeys(identity);
  return identity;
}

/**
 * Returns the existing on-device identity if one is already stored,
 * otherwise generates one and persists it. `prekeySignature` is always
 * recomputed from the (stored or freshly generated) keys rather than itself
 * persisted, so it can never drift out of sync with whichever keys are
 * currently stored.
 *
 * Safe to call concurrently: all calls that overlap with an in-flight call
 * resolve to that same call's result rather than each independently
 * checking storage and potentially generating their own identity.
 */
export function ensureLocalIdentity(): Promise<Identity> {
  if (inFlight === null) {
    inFlight = ensureLocalIdentityUncached().finally(() => {
      inFlight = null;
    });
  }

  return inFlight;
}
