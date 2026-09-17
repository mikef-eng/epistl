/**
 * PQXDH handshake + classical Double Ratchet session state machine.
 *
 * Manages one ratchet session per contact: the state shape, the two
 * key-derivation primitives (`KDF_RK`/`KDF_CK`) from Signal's published
 * Double Ratchet spec (https://signal.org/docs/specifications/doubleratchet/),
 * persistence, PQXDH handshake initialization for both the initiator and
 * responder roles, and the generic DH-ratchet-step + per-message key
 * derivation used for every message after the handshake. See
 * `docs/decisions/0005-pqxdh-handshake-classical-ratchet.md` for the overall
 * protocol shape and `docs/decisions/0006-pqxdh-session-key-derivation.md`
 * for the specific KDF/domain-separation/fail-closed choices made here.
 *
 * This module only produces raw key material (`messageKey` bytes) and
 * ratchet state — it does not define any wire/byte envelope format, does not
 * perform AEAD encryption or ML-DSA signing of message bytes, and does not
 * touch `ChatScreen.tsx` (see issue #41).
 */
import * as SecureStore from 'expo-secure-store';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { PREKEY_SIGNATURE_CONTEXT } from './identity';

/**
 * One contact's ratchet session state. Mirrors Signal's Double Ratchet spec
 * naming 1:1 (`DHs`/`DHr`/`RK`/`CKs`/`CKr`/`Ns`/`Nr`/`PN`) so this module can
 * be checked line-by-line against the spec.
 */
export type RatchetState = {
  /** RK: current 32-byte root key. */
  rootKey: Uint8Array;
  /** DHs: this device's current ratchet X25519 public key. */
  dhsPublicKey: Uint8Array;
  /** DHs: this device's current ratchet X25519 secret key. */
  dhsSecretKey: Uint8Array;
  /** DHr: the peer's most recently seen ratchet X25519 public key. */
  dhrPublicKey: Uint8Array | null;
  /** CKs: current sending chain key, or null before any chain exists. */
  sendingChainKey: Uint8Array | null;
  /** CKr: current receiving chain key, or null before any chain exists. */
  receivingChainKey: Uint8Array | null;
  /** Ns: number of messages sent in the current sending chain. */
  sendMessageNumber: number;
  /** Nr: number of messages received in the current receiving chain. */
  receiveMessageNumber: number;
  /** PN: number of messages sent in the previous sending chain. */
  previousSendingChainLength: number;
};

/**
 * Domain-separation prefix for the PQXDH initial root-key derivation.
 * Combined with `contactUserId`/`selfUserId` sorted lexicographically (see
 * `rootKeyInfoBytes`) so both parties derive an identical info string
 * regardless of who initiated the handshake.
 */
export const ROOT_KEY_INFO_PREFIX = 'epistl/v1/pqxdh/root/';

/**
 * Domain-separation info string for `KDF_RK`'s own internal HKDF call
 * (distinct from the initial `rootKey0` derivation's per-pair info string
 * above, which only runs once at handshake time). Fixed and non-secret;
 * exists purely so `KDF_RK` output can never collide with HKDF output
 * computed for an unrelated purpose using the same hash function.
 */
const KDF_RK_INFO = utf8ToBytes('epistl/v1/pqxdh/kdf_rk');

/** Single-byte KDF_CK inputs, per the Double Ratchet spec's reference notes. */
const KDF_CK_NEXT_CHAIN_KEY_INPUT = new Uint8Array([0x01]);
const KDF_CK_MESSAGE_KEY_INPUT = new Uint8Array([0x02]);

function rootKeyInfoBytes(contactUserId: string, selfUserId: string): Uint8Array {
  const [lower, higher] = [contactUserId, selfUserId].sort();
  return utf8ToBytes(`${ROOT_KEY_INFO_PREFIX}${lower}/${higher}`);
}

/**
 * HKDF-SHA256 step deriving a new 32-byte root key and 32-byte chain key
 * from the current root key and a fresh DH output. Per the Double Ratchet
 * spec's `KDF_RK`.
 */
export function KDF_RK(
  rootKey: Uint8Array,
  dhOutput: Uint8Array
): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const output = hkdf(sha256, dhOutput, rootKey, KDF_RK_INFO, 64);
  return { rootKey: output.slice(0, 32), chainKey: output.slice(32, 64) };
}

/**
 * HMAC-SHA256 chain step deriving the next chain key and a per-message key
 * from the current chain key. Per the Double Ratchet spec's `KDF_CK`.
 */
export function KDF_CK(chainKey: Uint8Array): {
  nextChainKey: Uint8Array;
  messageKey: Uint8Array;
} {
  return {
    nextChainKey: hmac(sha256, chainKey, KDF_CK_NEXT_CHAIN_KEY_INPUT),
    messageKey: hmac(sha256, chainKey, KDF_CK_MESSAGE_KEY_INPUT),
  };
}

function sessionStorageKey(contactUserId: string): string {
  return `epistl.ratchet_session.${contactUserId}`;
}

/**
 * Storage-only index of every `contactUserId` a ratchet session has ever
 * been saved for. `expo-secure-store` has no key-enumeration API, so
 * `clearAllSessions()` (issue #92's delete-account wipe) has no other way to
 * discover which per-contact session keys exist to delete. Maintained
 * exclusively by `saveSession`/`clearAllSessions` below; never read by any
 * handshake/ratchet logic in this module.
 */
const SESSION_INDEX_KEY = 'epistl.ratchet_session_index';

async function addToSessionIndex(contactUserId: string): Promise<void> {
  const raw = await SecureStore.getItemAsync(SESSION_INDEX_KEY);
  const index: string[] = raw === null ? [] : (JSON.parse(raw) as string[]);
  if (!index.includes(contactUserId)) {
    index.push(contactUserId);
    await SecureStore.setItemAsync(SESSION_INDEX_KEY, JSON.stringify(index));
  }
}

type SerializedRatchetState = {
  rootKey: string;
  dhsPublicKey: string;
  dhsSecretKey: string;
  dhrPublicKey: string | null;
  sendingChainKey: string | null;
  receivingChainKey: string | null;
  sendMessageNumber: number;
  receiveMessageNumber: number;
  previousSendingChainLength: number;
};

/**
 * Loads the persisted ratchet session for `contactUserId`, or `null` if no
 * session has been established with this contact yet.
 */
export async function loadSession(contactUserId: string): Promise<RatchetState | null> {
  const raw = await SecureStore.getItemAsync(sessionStorageKey(contactUserId));
  if (raw === null) {
    return null;
  }

  const parsed = JSON.parse(raw) as SerializedRatchetState;

  return {
    rootKey: base64ToBytes(parsed.rootKey),
    dhsPublicKey: base64ToBytes(parsed.dhsPublicKey),
    dhsSecretKey: base64ToBytes(parsed.dhsSecretKey),
    dhrPublicKey: parsed.dhrPublicKey === null ? null : base64ToBytes(parsed.dhrPublicKey),
    sendingChainKey:
      parsed.sendingChainKey === null ? null : base64ToBytes(parsed.sendingChainKey),
    receivingChainKey:
      parsed.receivingChainKey === null ? null : base64ToBytes(parsed.receivingChainKey),
    sendMessageNumber: parsed.sendMessageNumber,
    receiveMessageNumber: parsed.receiveMessageNumber,
    previousSendingChainLength: parsed.previousSendingChainLength,
  };
}

/** Persists `state` as the ratchet session for `contactUserId`. */
export async function saveSession(contactUserId: string, state: RatchetState): Promise<void> {
  const serialized: SerializedRatchetState = {
    rootKey: bytesToBase64(state.rootKey),
    dhsPublicKey: bytesToBase64(state.dhsPublicKey),
    dhsSecretKey: bytesToBase64(state.dhsSecretKey),
    dhrPublicKey: state.dhrPublicKey === null ? null : bytesToBase64(state.dhrPublicKey),
    sendingChainKey:
      state.sendingChainKey === null ? null : bytesToBase64(state.sendingChainKey),
    receivingChainKey:
      state.receivingChainKey === null ? null : bytesToBase64(state.receivingChainKey),
    sendMessageNumber: state.sendMessageNumber,
    receiveMessageNumber: state.receiveMessageNumber,
    previousSendingChainLength: state.previousSendingChainLength,
  };

  await SecureStore.setItemAsync(sessionStorageKey(contactUserId), JSON.stringify(serialized));
  await addToSessionIndex(contactUserId);
}

/**
 * Deletes every persisted ratchet session (per `saveSession`'s index) plus
 * the index itself, leaving no stored session state for any contact behind.
 * Storage-only -- does not touch handshake or ratchet-step logic. Used by
 * the delete-account flow (`SettingsScreen`, issue #92), which only calls
 * this after the server has confirmed the account itself is gone; never by
 * log-out (`api/session.ts`'s `clearSession`), which deliberately leaves
 * per-contact sessions intact so logging back in as the same user finds
 * them unchanged.
 *
 * Attempts every per-contact delete via `Promise.allSettled` rather than
 * `Promise.all`, so a single rejected `SecureStore.deleteItemAsync` call
 * can't prevent the others from being attempted. If every delete succeeds,
 * behavior is unchanged: `SESSION_INDEX_KEY` is deleted and this resolves
 * with `undefined`. If any delete fails, `SESSION_INDEX_KEY` is rewritten to
 * contain only the contacts whose delete failed (so it never lists a
 * contact whose session was actually deleted, and never omits one that
 * still exists), and this rejects with an `AggregateError` naming the
 * failed contact(s) instead of silently leaving the caller with stale
 * bookkeeping or an unhandled rejection. See issue #144.
 */
export async function clearAllSessions(): Promise<void> {
  const raw = await SecureStore.getItemAsync(SESSION_INDEX_KEY);
  const index: string[] = raw === null ? [] : (JSON.parse(raw) as string[]);
  const results = await Promise.allSettled(
    index.map((contactUserId) => SecureStore.deleteItemAsync(sessionStorageKey(contactUserId)))
  );

  const failures = index
    .map((contactUserId, i) => ({ contactUserId, result: results[i] }))
    .filter(
      (entry): entry is { contactUserId: string; result: PromiseRejectedResult } =>
        entry.result.status === 'rejected'
    );

  if (failures.length === 0) {
    await SecureStore.deleteItemAsync(SESSION_INDEX_KEY);
    return;
  }

  const failedContactUserIds = failures.map((failure) => failure.contactUserId);
  await SecureStore.setItemAsync(SESSION_INDEX_KEY, JSON.stringify(failedContactUserIds));

  throw new AggregateError(
    failures.map((failure) => failure.result.reason),
    `clearAllSessions: failed to delete session(s) for contact(s): ${failedContactUserIds.join(', ')}`
  );
}

/**
 * Verifies a contact's server-reported prekey bundle (issue #35's
 * `user_keys` fields) was signed by the claimed Dilithium identity key,
 * binding the X25519 and Kyber public keys together the same way
 * `identity.ts`'s `signPrekey` produced the signature. Never throws: a
 * malformed/garbage signature or key is treated the same as a mismatched
 * one and returns `false`, so a caller can block sending on a distinct
 * "untrusted bundle" error state without a session ever being created.
 */
export function verifyPrekeyBundle(bundle: {
  x25519PublicKey: Uint8Array;
  kyberPublicKey: Uint8Array;
  dilithiumPublicKey: Uint8Array;
  prekeySignature: Uint8Array;
}): boolean {
  try {
    return ml_dsa65.verify(
      bundle.prekeySignature,
      concatBytes(
        utf8ToBytes(PREKEY_SIGNATURE_CONTEXT),
        bundle.x25519PublicKey,
        bundle.kyberPublicKey
      ),
      bundle.dilithiumPublicKey
    );
  } catch {
    return false;
  }
}

/**
 * The Double Ratchet spec's generic `DHRatchet` step: given the current
 * state and a newly-observed peer ratchet public key (already confirmed to
 * differ from `state.dhrPublicKey`), derives a new receiving chain from the
 * existing local ratchet key, then generates a fresh local ratchet keypair
 * and derives a new sending chain from it. Exported for direct testing of
 * the sender-change ratchet step; not part of the public per-message API
 * (see `deriveNextSendingMessageKey`/`deriveNextReceivingMessageKey`).
 */
type RatchetedState = RatchetState & {
  dhrPublicKey: Uint8Array;
  sendingChainKey: Uint8Array;
  receivingChainKey: Uint8Array;
};

export function dhRatchetStep(state: RatchetState, newDhrPublicKey: Uint8Array): RatchetedState {
  const receiving = KDF_RK(state.rootKey, x25519.getSharedSecret(state.dhsSecretKey, newDhrPublicKey));

  const previousSendingChainLength = state.sendMessageNumber;
  const newDhs = x25519.keygen();
  const sending = KDF_RK(
    receiving.rootKey,
    x25519.getSharedSecret(newDhs.secretKey, newDhrPublicKey)
  );

  return {
    rootKey: sending.rootKey,
    dhsPublicKey: newDhs.publicKey,
    dhsSecretKey: newDhs.secretKey,
    dhrPublicKey: newDhrPublicKey,
    sendingChainKey: sending.chainKey,
    receivingChainKey: receiving.chainKey,
    sendMessageNumber: 0,
    receiveMessageNumber: 0,
    previousSendingChainLength,
  };
}

/**
 * Initiator (Alice) side of the PQXDH handshake. Generates a fresh
 * ephemeral X25519 keypair, combines an X25519 ECDH output with an
 * ML-KEM-768 encapsulation against the contact's Kyber public key to derive
 * the initial root key, then takes one `KDF_RK` step (over the classical DH
 * output only) to derive the initial sending chain. Does not call
 * `saveSession` — persistence is the caller's responsibility.
 */
export function initiateSession(params: {
  contactUserId: string;
  selfUserId: string;
  contactBundle: { x25519PublicKey: Uint8Array; kyberPublicKey: Uint8Array };
}): { state: RatchetState; ea: Uint8Array; kyberCiphertext: Uint8Array } {
  const ea = x25519.keygen();
  const dhOutput = x25519.getSharedSecret(ea.secretKey, params.contactBundle.x25519PublicKey);
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(params.contactBundle.kyberPublicKey);

  const infoBytes = rootKeyInfoBytes(params.contactUserId, params.selfUserId);
  const rootKey0 = hkdf(sha256, concatBytes(dhOutput, sharedSecret), undefined, infoBytes, 32);

  const { rootKey, chainKey } = KDF_RK(rootKey0, dhOutput);

  const state: RatchetState = {
    rootKey,
    dhsPublicKey: ea.publicKey,
    dhsSecretKey: ea.secretKey,
    dhrPublicKey: null,
    sendingChainKey: chainKey,
    receivingChainKey: null,
    sendMessageNumber: 0,
    receiveMessageNumber: 0,
    previousSendingChainLength: 0,
  };

  return { state, ea: ea.publicKey, kyberCiphertext: cipherText };
}

/**
 * Responder (Bob) side of the PQXDH handshake. Derives the identical
 * `rootKey0` via the symmetric domain-separated HKDF call, starts from this
 * device's own static X25519 keypair with `dhrPublicKey: null` (matching
 * Signal's `RatchetInitBob`), then immediately runs that starting state
 * through the generic DH-ratchet-step logic against the initiator's `ea`
 * (since `dhrPublicKey` starts `null`, it differs from `ea` and triggers a
 * ratchet step) — this both derives Bob's receiving chain (from his static
 * key and `ea`) and generates Bob's first fresh ephemeral keypair + sending
 * chain (from that fresh key and `ea`), matching Signal's combined
 * `RatchetInitBob` + `DHRatchet` flow for a responder's first inbound
 * message. Does not call `saveSession`.
 */
export function receiveHandshake(params: {
  contactUserId: string;
  selfUserId: string;
  ea: Uint8Array;
  kyberCiphertext: Uint8Array;
  selfX25519SecretKey: Uint8Array;
  selfKyberSecretKey: Uint8Array;
}): { state: RatchetState } {
  const dhOutput = x25519.getSharedSecret(params.selfX25519SecretKey, params.ea);
  const sharedSecret = ml_kem768.decapsulate(params.kyberCiphertext, params.selfKyberSecretKey);

  const infoBytes = rootKeyInfoBytes(params.contactUserId, params.selfUserId);
  const rootKey0 = hkdf(sha256, concatBytes(dhOutput, sharedSecret), undefined, infoBytes, 32);

  const startingState: RatchetState = {
    rootKey: rootKey0,
    dhsPublicKey: x25519.getPublicKey(params.selfX25519SecretKey),
    dhsSecretKey: params.selfX25519SecretKey,
    dhrPublicKey: null,
    sendingChainKey: null,
    receivingChainKey: null,
    sendMessageNumber: 0,
    receiveMessageNumber: 0,
    previousSendingChainLength: 0,
  };

  return { state: dhRatchetStep(startingState, params.ea) };
}

/**
 * The only function callers use to get a per-message send key — for message
 * 0 of a brand-new session (immediately after `initiateSession`) and for
 * every later message alike. Advances `state.sendingChainKey` via
 * `KDF_CK`, increments `sendMessageNumber`, and returns the message key plus
 * a header describing the current local ratchet public key, the length of
 * the previous sending chain, and the message number just consumed.
 */
export function deriveNextSendingMessageKey(state: RatchetState): {
  messageKey: Uint8Array;
  nextState: RatchetState;
  header: { dhPublicKey: Uint8Array; previousChainLength: number; messageNumber: number };
} {
  if (state.sendingChainKey === null) {
    throw new Error('deriveNextSendingMessageKey: no sending chain established yet');
  }

  const { nextChainKey, messageKey } = KDF_CK(state.sendingChainKey);
  const messageNumber = state.sendMessageNumber;

  const nextState: RatchetState = {
    ...state,
    sendingChainKey: nextChainKey,
    sendMessageNumber: state.sendMessageNumber + 1,
  };

  return {
    messageKey,
    nextState,
    header: {
      dhPublicKey: state.dhsPublicKey,
      previousChainLength: state.previousSendingChainLength,
      messageNumber,
    },
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Derives the message key for an inbound message. If `peerDhPublicKey`
 * differs from `state.dhrPublicKey`, this is a genuine later ratchet step
 * (note `receiveHandshake` already sets `dhrPublicKey = ea`, so message 0
 * right after a handshake does not hit this branch): runs the generic
 * DH-ratchet-step logic first, then derives message 0 of the new receiving
 * chain. Otherwise, if `messageNumber` does not match
 * `state.receiveMessageNumber`, returns `{ rejected: true }` and leaves
 * `state` byte-for-byte unchanged — this function never throws for an
 * out-of-order message, it fails closed (no skipped-message-key recovery;
 * see the ADR). Otherwise, advances `state.receivingChainKey` via `KDF_CK`,
 * increments `receiveMessageNumber`, and returns the message key.
 */
export function deriveNextReceivingMessageKey(
  state: RatchetState,
  peerDhPublicKey: Uint8Array,
  messageNumber: number
): { messageKey: Uint8Array; nextState: RatchetState } | { rejected: true } {
  if (state.dhrPublicKey === null || !bytesEqual(peerDhPublicKey, state.dhrPublicKey)) {
    // Genuine later ratchet step (message 0 right after a handshake never
    // reaches here: `receiveHandshake` already sets `dhrPublicKey = ea`).
    // The new chain's message 0 is derived unconditionally, matching the
    // sender side always resetting its own message number to 0 whenever it
    // generates a fresh ratchet keypair (see `dhRatchetStep`).
    const ratchetedState = dhRatchetStep(state, peerDhPublicKey);
    const { nextChainKey, messageKey } = KDF_CK(ratchetedState.receivingChainKey);

    const nextState: RatchetState = {
      ...ratchetedState,
      receivingChainKey: nextChainKey,
      receiveMessageNumber: ratchetedState.receiveMessageNumber + 1,
    };

    return { messageKey, nextState };
  }

  if (messageNumber !== state.receiveMessageNumber) {
    // Fail closed: no skipped-message-key storage/recovery (Signal's
    // `MKSKIPPED`) in this MVP — see the ADR. `state` is returned untouched
    // (this function only ever reads from `state`, never writes into it),
    // so this never throws and never mutates the caller's state.
    return { rejected: true };
  }

  if (state.receivingChainKey === null) {
    // Defensive only: cannot happen post-handshake, since
    // `receiveHandshake` always sets `dhrPublicKey` and `receivingChainKey`
    // together via the ratchet-step branch above. Fail closed rather than
    // throw if it somehow did.
    return { rejected: true };
  }

  const { nextChainKey, messageKey } = KDF_CK(state.receivingChainKey);

  const nextState: RatchetState = {
    ...state,
    receivingChainKey: nextChainKey,
    receiveMessageNumber: state.receiveMessageNumber + 1,
  };

  return { messageKey, nextState };
}
