/**
 * Binary envelope wire format for PQXDH/Double-Ratchet-protected messages.
 *
 * Packs `./session.ts`'s (issue #40) ratchet key material into two signed,
 * authenticated binary layouts, and decodes them back — this is the only
 * place that touches XChaCha20-Poly1305 AEAD or ML-DSA-65 message signing.
 * `./session.ts` produces raw key material and ratchet state; it never
 * defines a byte layout or performs AEAD/signing itself (see its own
 * module doc comment). See
 * `docs/decisions/0006-pqxdh-session-key-derivation.md`'s "Envelope wire
 * format" section for the two byte layouts and their rationale.
 *
 * Both layouts end with a fixed-length ML-DSA-65 signature (3309 bytes,
 * FIPS 204-standard for this parameter set) sliced from the end of the
 * buffer, covering every preceding byte (version through AEAD
 * ciphertext+tag). The per-message AEAD key is `messageKey` from
 * `deriveNextSendingMessageKey`/`deriveNextReceivingMessageKey`, used
 * directly as the XChaCha20-Poly1305 key — no further HKDF at this layer.
 *
 * A verification failure (AEAD decryption failure, `ml_dsa65.verify`
 * failure, or a fail-closed out-of-order rejection from `./session.ts`) is
 * a hard "cannot be trusted" result: every decode function below returns a
 * discriminated `{ ok: false, reason }` in every such case, never partial
 * or garbage plaintext, and never throws for attacker-controlled input.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { concatBytes, randomBytes } from '@noble/hashes/utils.js';

import { utf8ToBytes } from '../utils/base64';
import {
  deriveNextReceivingMessageKey,
  receiveHandshake,
  type RatchetState,
} from './session';

/** Sent only as the very first message of a brand-new session. Retired
 * version `0x01` (the pre-ADR-0005 single-shot design) is deliberately not
 * a member of this union — no code path decodes it. */
export const HANDSHAKE_ENVELOPE_VERSION = 0x02;
/** Used for every message once a session is established, including the
 * responder's very first reply. */
export const RATCHET_ENVELOPE_VERSION = 0x03;

/** RFC 7748-standard X25519 public key size. */
export const X25519_PUBLIC_KEY_LENGTH = 32;
/** FIPS 203-standard ML-KEM-768 ciphertext size. */
export const KYBER_CIPHERTEXT_LENGTH = 1088;
/** Big-endian message-number / chain-length wire field size. */
export const UINT32_FIELD_LENGTH = 4;
/** XChaCha20-Poly1305 uses a 24-byte extended nonce. */
export const XCHACHA20POLY1305_NONCE_LENGTH = 24;
/** Poly1305 authentication tag size, appended to the AEAD ciphertext. */
export const AEAD_TAG_LENGTH = 16;
/** FIPS 204-standard ML-DSA-65 signature size. */
export const ML_DSA65_SIGNATURE_LENGTH = 3309;

/** Successful decode: the recovered plaintext and the ratchet state to
 * persist via `saveSession` (skip persistence entirely on any failure). */
export interface EnvelopeDecodeSuccess {
  ok: true;
  plaintext: Uint8Array;
  nextState: RatchetState;
}

/** A decode failure is always a hard "cannot be trusted" result. Callers
 * must not display any associated plaintext, and must not call
 * `saveSession` (local ratchet state is left unchanged) — see the
 * out-of-order handling note above. `reason` is diagnostic only; every
 * caller in this codebase treats all of these identically. */
export interface EnvelopeDecodeFailure {
  ok: false;
  reason: 'unrecognized_version' | 'malformed' | 'signature_failure' | 'rejected' | 'aead_failure';
}

export type EnvelopeDecodeResult = EnvelopeDecodeSuccess | EnvelopeDecodeFailure;

function writeUint32BE(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  );
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/** AAD binds ciphertext to a specific conversation direction: the
 * concatenated sender+recipient user id bytes (this codebase treats user
 * ids as opaque strings everywhere else — see `rootKeyInfoBytes` in
 * `./session.ts` for the same precedent — so "raw ... UUID bytes" here
 * means the id string's raw UTF-8 bytes, not a parsed 16-byte binary UUID;
 * see the ADR's envelope section for why). */
function directionAad(senderUserId: string, recipientUserId: string): Uint8Array {
  return concatBytes(utf8ToBytes(senderUserId), utf8ToBytes(recipientUserId));
}

/** Never throws: a malformed/garbage signature or key is treated as a
 * verification failure like any other, not an exception. */
function verifySignature(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ml_dsa65.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

export interface EncodeHandshakeEnvelopeParams {
  /** `initiateSession`'s returned ephemeral X25519 public key. */
  ea: Uint8Array;
  /** `initiateSession`'s returned ML-KEM-768 ciphertext. */
  kyberCiphertext: Uint8Array;
  /** `deriveNextSendingMessageKey`'s returned message-0 key. */
  messageKey: Uint8Array;
  plaintext: Uint8Array;
  /** This device's own user id (the sender). */
  selfUserId: string;
  /** The contact's user id (the recipient). */
  contactUserId: string;
  /** This device's Dilithium secret key, from `../crypto/identity.ts`. */
  signingSecretKey: Uint8Array;
}

/**
 * Encodes a handshake-init envelope (version `0x02`):
 * `[1B version][32B EA][1088B ML-KEM-768 ciphertext][4B BE message number,
 * always 0][24B XChaCha20-Poly1305 nonce][AEAD ciphertext+16B tag][3309B
 * ML-DSA-65 signature]`.
 */
export function encodeHandshakeEnvelope(params: EncodeHandshakeEnvelopeParams): Uint8Array {
  const nonce = randomBytes(XCHACHA20POLY1305_NONCE_LENGTH);
  const aad = directionAad(params.selfUserId, params.contactUserId);
  const ciphertext = xchacha20poly1305(params.messageKey, nonce, aad).encrypt(params.plaintext);

  const signedPortion = concatBytes(
    Uint8Array.of(HANDSHAKE_ENVELOPE_VERSION),
    params.ea,
    params.kyberCiphertext,
    writeUint32BE(0),
    nonce,
    ciphertext
  );
  const signature = ml_dsa65.sign(signedPortion, params.signingSecretKey);

  return concatBytes(signedPortion, signature);
}

export interface DecodeHandshakeEnvelopeParams {
  /** The initiating contact's user id (the sender of this envelope). */
  contactUserId: string;
  /** This device's own user id (the recipient). */
  selfUserId: string;
  /** This device's X25519 secret key, from `../crypto/identity.ts`. */
  selfX25519SecretKey: Uint8Array;
  /** This device's Kyber secret key, from `../crypto/identity.ts`. */
  selfKyberSecretKey: Uint8Array;
  /** The sender's Dilithium public key, from `listContacts()`. */
  senderDilithiumPublicKey: Uint8Array;
}

const HANDSHAKE_ENVELOPE_MIN_LENGTH =
  1 +
  X25519_PUBLIC_KEY_LENGTH +
  KYBER_CIPHERTEXT_LENGTH +
  UINT32_FIELD_LENGTH +
  XCHACHA20POLY1305_NONCE_LENGTH +
  AEAD_TAG_LENGTH +
  ML_DSA65_SIGNATURE_LENGTH;

/**
 * Decodes a handshake-init envelope. Verifies the ML-DSA-65 signature
 * before doing anything else (an envelope that fails signature
 * verification is never handed to `receiveHandshake`), then calls
 * issue #40's `receiveHandshake` (responder role) followed by
 * `deriveNextReceivingMessageKey` for message 0, then AEAD-decrypts. Never
 * throws for malformed/attacker-controlled `envelope` bytes.
 */
export function decodeHandshakeEnvelope(
  envelope: Uint8Array,
  params: DecodeHandshakeEnvelopeParams
): EnvelopeDecodeResult {
  if (envelope.length < HANDSHAKE_ENVELOPE_MIN_LENGTH) {
    return { ok: false, reason: 'malformed' };
  }
  if (envelope[0] !== HANDSHAKE_ENVELOPE_VERSION) {
    return { ok: false, reason: 'unrecognized_version' };
  }

  let offset = 1;
  const ea = envelope.slice(offset, offset + X25519_PUBLIC_KEY_LENGTH);
  offset += X25519_PUBLIC_KEY_LENGTH;
  const kyberCiphertext = envelope.slice(offset, offset + KYBER_CIPHERTEXT_LENGTH);
  offset += KYBER_CIPHERTEXT_LENGTH;
  const messageNumber = readUint32BE(envelope, offset);
  offset += UINT32_FIELD_LENGTH;
  const nonce = envelope.slice(offset, offset + XCHACHA20POLY1305_NONCE_LENGTH);
  offset += XCHACHA20POLY1305_NONCE_LENGTH;

  const signedLength = envelope.length - ML_DSA65_SIGNATURE_LENGTH;
  if (signedLength <= offset || messageNumber !== 0) {
    return { ok: false, reason: 'malformed' };
  }
  const ciphertext = envelope.slice(offset, signedLength);
  const signedPortion = envelope.slice(0, signedLength);
  const signature = envelope.slice(signedLength);

  if (!verifySignature(signature, signedPortion, params.senderDilithiumPublicKey)) {
    return { ok: false, reason: 'signature_failure' };
  }

  const { state } = receiveHandshake({
    contactUserId: params.contactUserId,
    selfUserId: params.selfUserId,
    ea,
    kyberCiphertext,
    selfX25519SecretKey: params.selfX25519SecretKey,
    selfKyberSecretKey: params.selfKyberSecretKey,
  });

  const received = deriveNextReceivingMessageKey(state, ea, 0);
  if ('rejected' in received) {
    return { ok: false, reason: 'rejected' };
  }

  const aad = directionAad(params.contactUserId, params.selfUserId);
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(received.messageKey, nonce, aad).decrypt(ciphertext);
  } catch {
    return { ok: false, reason: 'aead_failure' };
  }

  return { ok: true, plaintext, nextState: received.nextState };
}

export interface EncodeRatchetEnvelopeParams {
  /** `deriveNextSendingMessageKey`'s returned header. */
  header: { dhPublicKey: Uint8Array; previousChainLength: number; messageNumber: number };
  /** `deriveNextSendingMessageKey`'s returned message key. */
  messageKey: Uint8Array;
  plaintext: Uint8Array;
  /** This device's own user id (the sender). */
  selfUserId: string;
  /** The contact's user id (the recipient). */
  contactUserId: string;
  /** This device's Dilithium secret key, from `../crypto/identity.ts`. */
  signingSecretKey: Uint8Array;
}

/**
 * Encodes a ratchet envelope (version `0x03`), used for every message once
 * a session is established: `[1B version][32B current DH ratchet public
 * key][4B BE previous sending chain length][4B BE message number][24B
 * XChaCha20-Poly1305 nonce][AEAD ciphertext+16B tag][3309B ML-DSA-65
 * signature]`.
 */
export function encodeRatchetEnvelope(params: EncodeRatchetEnvelopeParams): Uint8Array {
  const nonce = randomBytes(XCHACHA20POLY1305_NONCE_LENGTH);
  const aad = directionAad(params.selfUserId, params.contactUserId);
  const ciphertext = xchacha20poly1305(params.messageKey, nonce, aad).encrypt(params.plaintext);

  const signedPortion = concatBytes(
    Uint8Array.of(RATCHET_ENVELOPE_VERSION),
    params.header.dhPublicKey,
    writeUint32BE(params.header.previousChainLength),
    writeUint32BE(params.header.messageNumber),
    nonce,
    ciphertext
  );
  const signature = ml_dsa65.sign(signedPortion, params.signingSecretKey);

  return concatBytes(signedPortion, signature);
}

export interface DecodeRatchetEnvelopeParams {
  /** The current ratchet session state for this contact (never `null` —
   * callers decode a ratchet envelope only once a session exists). */
  state: RatchetState;
  /** The sender's Dilithium public key, from `listContacts()`. */
  senderDilithiumPublicKey: Uint8Array;
  /** This device's own user id (the recipient). */
  selfUserId: string;
  /** The contact's user id (the sender of this envelope). */
  contactUserId: string;
}

const RATCHET_ENVELOPE_MIN_LENGTH =
  1 +
  X25519_PUBLIC_KEY_LENGTH +
  UINT32_FIELD_LENGTH * 2 +
  XCHACHA20POLY1305_NONCE_LENGTH +
  AEAD_TAG_LENGTH +
  ML_DSA65_SIGNATURE_LENGTH;

/**
 * Decodes a ratchet envelope. Verifies the ML-DSA-65 signature first, then
 * calls issue #40's `deriveNextReceivingMessageKey(state, header.dhPublicKey,
 * header.messageNumber)`: a `{ rejected: true }` result (out-of-order/fail
 * closed — see the ADR) is surfaced as `{ ok: false, reason: 'rejected' }`
 * without attempting decryption, and `state` is never mutated by this
 * module (the caller's persisted state is only ever touched via its own
 * `saveSession` call, and only on a successful decode). Never throws for
 * malformed/attacker-controlled `envelope` bytes.
 */
export function decodeRatchetEnvelope(
  envelope: Uint8Array,
  params: DecodeRatchetEnvelopeParams
): EnvelopeDecodeResult {
  if (envelope.length < RATCHET_ENVELOPE_MIN_LENGTH) {
    return { ok: false, reason: 'malformed' };
  }
  if (envelope[0] !== RATCHET_ENVELOPE_VERSION) {
    return { ok: false, reason: 'unrecognized_version' };
  }

  let offset = 1;
  const dhPublicKey = envelope.slice(offset, offset + X25519_PUBLIC_KEY_LENGTH);
  offset += X25519_PUBLIC_KEY_LENGTH;
  offset += UINT32_FIELD_LENGTH; // previousChainLength: signed over, not needed to decrypt.
  const messageNumber = readUint32BE(envelope, offset);
  offset += UINT32_FIELD_LENGTH;
  const nonce = envelope.slice(offset, offset + XCHACHA20POLY1305_NONCE_LENGTH);
  offset += XCHACHA20POLY1305_NONCE_LENGTH;

  const signedLength = envelope.length - ML_DSA65_SIGNATURE_LENGTH;
  if (signedLength <= offset) {
    return { ok: false, reason: 'malformed' };
  }
  const ciphertext = envelope.slice(offset, signedLength);
  const signedPortion = envelope.slice(0, signedLength);
  const signature = envelope.slice(signedLength);

  if (!verifySignature(signature, signedPortion, params.senderDilithiumPublicKey)) {
    return { ok: false, reason: 'signature_failure' };
  }

  const received = deriveNextReceivingMessageKey(params.state, dhPublicKey, messageNumber);
  if ('rejected' in received) {
    return { ok: false, reason: 'rejected' };
  }

  const aad = directionAad(params.contactUserId, params.selfUserId);
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(received.messageKey, nonce, aad).decrypt(ciphertext);
  } catch {
    return { ok: false, reason: 'aead_failure' };
  }

  return { ok: true, plaintext, nextState: received.nextState };
}
