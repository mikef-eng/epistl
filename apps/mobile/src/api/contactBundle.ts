/**
 * Decodes a contact's server-reported PQXDH key bundle (issue #35's
 * `user_keys` fields, returned by `listContacts()`) from base64 into raw
 * bytes. Shared by `../screens/ChatScreen.tsx` (outgoing sends) and
 * `../inbox/listener.ts` (issue #165's app-level inbox listener, incoming
 * decode for every contact) so both derive the same key-bundle shape from
 * the same `Contact` row instead of keeping two copies in sync.
 */
import type { Contact } from './client';
import { base64ToBytes } from '../utils/base64';

/** This device's view of a contact's server-reported PQXDH key bundle. */
export interface ContactKeyBundle {
  x25519PublicKey: Uint8Array;
  kyberPublicKey: Uint8Array;
  dilithiumPublicKey: Uint8Array;
  prekeySignature: Uint8Array;
}

/** Returns `null` if `contact` hasn't uploaded a key bundle yet (any of the
 * four base64 fields is `null`). */
export function bundleFromContact(contact: Contact): ContactKeyBundle | null {
  if (
    contact.x25519_public_key_b64 === null ||
    contact.kyber_public_key_b64 === null ||
    contact.dilithium_public_key_b64 === null ||
    contact.prekey_signature_b64 === null
  ) {
    return null;
  }
  return {
    x25519PublicKey: base64ToBytes(contact.x25519_public_key_b64),
    kyberPublicKey: base64ToBytes(contact.kyber_public_key_b64),
    dilithiumPublicKey: base64ToBytes(contact.dilithium_public_key_b64),
    prekeySignature: base64ToBytes(contact.prekey_signature_b64),
  };
}
