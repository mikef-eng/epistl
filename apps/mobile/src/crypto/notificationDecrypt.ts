/**
 * Decrypt-for-notification: turns a content-free push (`fromUserId` only)
 * into preview text inside a non-main process (iOS NSE / Android background
 * FCM handler), and gives the main app a receive path that shares the same
 * ratchet state safely. See
 * `docs/decisions/0022-notification-decrypt-shared-session-state.md`.
 *
 * Pure TypeScript: storage, cross-process lock and envelope fetch are
 * injected (concrete implementations: issues #249 fetch endpoint, #250
 * native storage/lock). No crypto is implemented here -- envelope
 * verification/decryption is `decodeRatchetEnvelope`, unchanged.
 *
 * Protocol: fetch (outside the lock) -> acquire per-contact lock -> read
 * `{state, generation}` -> decode -> single compare-and-set write of the
 * advanced state AND the decrypted plaintext keyed by message id -> release.
 * Nothing is persisted on any failure, so the queued envelope stays intact
 * for the main app.
 */
import { sha256 } from '@noble/hashes/sha2.js';

import { bytesToUtf8 } from '../utils/base64';
import {
  decodeRatchetEnvelope,
  HANDSHAKE_ENVELOPE_VERSION,
  RATCHET_ENVELOPE_VERSION,
} from './envelope';
import type { RatchetState } from './session';

/** Persisted ratchet state plus its monotonic version counter. */
export type StoredSession = { state: RatchetState; generation: number };

/**
 * Decrypted-message record. Bound to the exact envelope it came from via
 * `envelopeDigest` (sha256 of the envelope bytes) so a relay-chosen
 * `messageId` alone can never select stored plaintext. `plaintext` is the
 * exact decrypted bytes (the ratchet key is single-use, so it must be
 * lossless); storage implementations serialize it as they see fit.
 */
export type StoredDecrypted = { envelopeDigest: Uint8Array; plaintext: Uint8Array };

export type WriteResult = { ok: true; generation: number } | { ok: false; reason: 'stale' };

/**
 * Storage shared by both processes (App Group / Android shared storage).
 * `write` MUST be an atomic compare-and-set: it succeeds only if the stored
 * generation equals `expectedGeneration` (0 when no session exists), sets the
 * new generation to `expectedGeneration + 1`, and persists the optional
 * decrypted-message record in the same atomic operation.
 */
export interface SessionStore {
  read(contactUserId: string): Promise<StoredSession | null>;
  write(
    contactUserId: string,
    state: RatchetState,
    expectedGeneration: number,
    decrypted?: { messageId: string } & StoredDecrypted
  ): Promise<WriteResult>;
  /** Decrypted record previously stored for `messageId`, or null. */
  getDecrypted(contactUserId: string, messageId: string): Promise<StoredDecrypted | null>;
  /** Removes the record; the main app calls this after ingesting the message. */
  deleteDecrypted(contactUserId: string, messageId: string): Promise<void>;
}

/** Per-contact cross-process lock. `acquire` resolves null on timeout. */
export interface Lock {
  acquire(contactUserId: string, timeoutMs: number): Promise<(() => Promise<void>) | null>;
}

export type FetchEnvelope = (
  fromUserId: string
) => Promise<{ ok: true; messageId: string; envelope: Uint8Array } | { ok: false }>;

export const DEFAULT_LOCK_TIMEOUT_MS = 5000;

export interface NotificationDecryptDeps {
  sessionStore: SessionStore;
  lock: Lock;
  fetchEnvelope: FetchEnvelope;
  selfUserId: string;
  /** Sender's Dilithium public key (from the shared contact store). */
  resolveSenderKey(contactUserId: string): Promise<Uint8Array | null>;
  lockTimeoutMs?: number;
}

export type NotificationDecryptFailureReason =
  | 'no_session'
  | 'fetch_failed'
  | 'lock_timeout'
  | 'corrupt_envelope'
  | 'unsupported_envelope'
  | 'decrypt_failure'
  | 'state_conflict'
  | 'storage_error';

export type NotificationDecryptResult =
  | { ok: true; senderUserId: string; previewText: string }
  | { ok: false; reason: NotificationDecryptFailureReason };

type ReceiveResult =
  | { ok: true; plaintext: Uint8Array }
  | { ok: false; reason: NotificationDecryptFailureReason };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Stored plaintext for `messageId`, only if bound to this exact envelope. */
async function cachedFor(
  store: SessionStore,
  contactUserId: string,
  messageId: string,
  digest: Uint8Array
): Promise<Uint8Array | null> {
  const cached = await store.getDecrypted(contactUserId, messageId);
  if (cached !== null && bytesEqual(cached.envelopeDigest, digest)) {
    return cached.plaintext;
  }
  return null;
}

async function receiveLocked(
  contactUserId: string,
  messageId: string,
  envelope: Uint8Array,
  deps: Omit<NotificationDecryptDeps, 'fetchEnvelope'>
): Promise<ReceiveResult> {
  let release: (() => Promise<void>) | null;
  try {
    release = await deps.lock.acquire(contactUserId, deps.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  } catch {
    return { ok: false, reason: 'lock_timeout' };
  }
  if (release === null) {
    return { ok: false, reason: 'lock_timeout' };
  }
  try {
    const stored = await deps.sessionStore.read(contactUserId);
    if (stored === null) {
      return { ok: false, reason: 'no_session' };
    }

    // Already decrypted by the other process: never advance the ratchet twice.
    const digest = sha256(envelope);
    const cached = await cachedFor(deps.sessionStore, contactUserId, messageId, digest);
    if (cached !== null) {
      return { ok: true, plaintext: cached };
    }

    if (envelope.length > 0 && envelope[0] === HANDSHAKE_ENVELOPE_VERSION) {
      // First message of a session needs static keys not shared with the
      // extension; leave it for the main app.
      return { ok: false, reason: 'unsupported_envelope' };
    }
    if (envelope.length === 0 || envelope[0] !== RATCHET_ENVELOPE_VERSION) {
      return { ok: false, reason: 'corrupt_envelope' };
    }
    const senderKey = await deps.resolveSenderKey(contactUserId);
    if (senderKey === null) {
      return { ok: false, reason: 'no_session' };
    }

    const decoded = decodeRatchetEnvelope(envelope, {
      state: stored.state,
      senderDilithiumPublicKey: senderKey,
      selfUserId: deps.selfUserId,
      contactUserId,
    });
    if (!decoded.ok) {
      return {
        ok: false,
        reason:
          decoded.reason === 'malformed' || decoded.reason === 'unrecognized_version'
            ? 'corrupt_envelope'
            : 'decrypt_failure',
      };
    }

    const plaintext = decoded.plaintext;
    const written = await deps.sessionStore.write(
      contactUserId,
      decoded.nextState,
      stored.generation,
      { messageId, envelopeDigest: digest, plaintext }
    );
    if (!written.ok) {
      // The other process may have won the race for this very message.
      const winner = await cachedFor(deps.sessionStore, contactUserId, messageId, digest);
      if (winner !== null) {
        return { ok: true, plaintext: winner };
      }
      return { ok: false, reason: 'state_conflict' };
    }
    return { ok: true, plaintext };
  } catch {
    return { ok: false, reason: 'storage_error' };
  } finally {
    try {
      await release();
    } catch {
      // Lock implementations must expire stale holders; nothing more to do.
    }
  }
}

/** Notification-process entry point. Never throws for normal failures. */
export async function notificationDecrypt(
  fromUserId: string,
  deps: NotificationDecryptDeps
): Promise<NotificationDecryptResult> {
  let fetched: Awaited<ReturnType<FetchEnvelope>>;
  try {
    fetched = await deps.fetchEnvelope(fromUserId);
  } catch {
    return { ok: false, reason: 'fetch_failed' };
  }
  if (!fetched.ok) {
    return { ok: false, reason: 'fetch_failed' };
  }

  const result = await receiveLocked(fromUserId, fetched.messageId, fetched.envelope, deps);
  if (!result.ok) {
    return result;
  }
  return { ok: true, senderUserId: fromUserId, previewText: bytesToUtf8(result.plaintext) };
}

/**
 * Main-app receive path over the same shared state: an envelope whose
 * `messageId` the notification process already decrypted resolves to the
 * stored plaintext without touching the ratchet.
 */
export async function receiveEnvelopeShared(
  contactUserId: string,
  messageId: string,
  envelope: Uint8Array,
  deps: Omit<NotificationDecryptDeps, 'fetchEnvelope'>
): Promise<
  { ok: true; plaintext: Uint8Array } | { ok: false; reason: NotificationDecryptFailureReason }
> {
  const result = await receiveLocked(contactUserId, messageId, envelope, deps);
  if (!result.ok) {
    return result;
  }
  return { ok: true, plaintext: result.plaintext };
}
