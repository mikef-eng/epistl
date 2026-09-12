/**
 * Ensures the device's public key bundle (issue #36's `ensureLocalIdentity`)
 * is registered with the server (issue #35's `POST /api/keys`) after a
 * successful login/signup.
 *
 * "Registered" is tracked via a small persisted marker storing the user id
 * the device's keys were last successfully uploaded for, so a device that
 * already uploaded its keys for this user doesn't re-upload on every login.
 * This marker is a pragmatic MVP shortcut to avoid a redundant network call,
 * not a security boundary: worst case it's stale, causing one extra or one
 * missed upload attempt, which self-corrects on the next successful login.
 */
import * as SecureStore from 'expo-secure-store';

import { registerKeys } from '../api/client';
import { bytesToBase64 } from '../utils/base64';
import { ensureLocalIdentity } from './identity';

export const KEYS_UPLOADED_FOR_USER_ID_KEY = 'epistl.keys_uploaded_for_user_id';

/**
 * Ensures this device has a local identity and, unless this device's keys
 * have already been confirmed uploaded for `userId`, uploads its public key
 * bundle to the server and records the marker on success.
 *
 * Never rejects: login/signup must complete and reach the Contacts screen
 * even if this fails (e.g. a network error), so any error here is swallowed
 * and the marker is left unset, which makes the next successful login retry
 * the upload automatically.
 */
export async function ensureKeysRegistered(userId: string): Promise<void> {
  try {
    const uploadedForUserId = await SecureStore.getItemAsync(KEYS_UPLOADED_FOR_USER_ID_KEY);
    if (uploadedForUserId === userId) {
      return;
    }

    const identity = await ensureLocalIdentity();
    await registerKeys(
      bytesToBase64(identity.x25519PublicKey),
      bytesToBase64(identity.kyberPublicKey),
      bytesToBase64(identity.dilithiumPublicKey),
      bytesToBase64(identity.prekeySignature)
    );
    await SecureStore.setItemAsync(KEYS_UPLOADED_FOR_USER_ID_KEY, userId);
  } catch {
    // Swallow: see the doc comment above. The marker is left unset above
    // (either because we returned early, or because the write above never
    // ran), so the next successful login retries.
  }
}
