/**
 * App-level global inbox listener (issue #165).
 *
 * Before this module existed, `../screens/ChatScreen.tsx` was the only
 * consumer of incoming relay frames: it decoded/verified a live envelope
 * only for the one contact its `route.params` happened to be open for,
 * silently dropping (`if (frame.from !== contactUserId) return;`) any frame
 * from every other contact -- an unrecoverable loss, since the server
 * already acks/dequeues a message the moment it's handed off over the live
 * connection (`docs/decisions/0008-jetstream-transient-offline-queue.md`).
 *
 * This module is the single place (besides `ChatScreen.tsx` itself, for its
 * own outgoing sends) that decodes/verifies an incoming envelope: it
 * subscribes to `../transport/store.ts`'s `transportStore` directly (not as
 * a React hook, so it runs independent of any screen's mount state),
 * processes every `message` frame regardless of `from`, and on success
 * persists via `../crypto/session.ts`'s `saveSession` +
 * `../storage/messages.ts`'s `saveMessage`. `../inbox/appSession.ts` starts
 * this once the authenticated app's root mounts (see that module's doc
 * comment) and stops it on logout.
 *
 * A frame is decoded/verified at most once: `startInboxListener` seeds its
 * "already processed" marker with whatever `lastFrame` already holds at
 * start time (so a frame left over from a previous session isn't
 * reprocessed), and every subsequent `transportStore` state change is
 * compared by object identity against the last-processed frame before
 * anything is decoded -- decoding is stateful/consuming (it advances the
 * ratchet chain key), so decoding the same frame twice would desynchronize
 * the ratchet. `ChatScreen.tsx` no longer decodes live frames for its own
 * contact at all; it only renders `inboxStore`'s published output (see
 * below), so there is exactly one decode call site for any given frame.
 *
 * A decode/verification failure is handled exactly as `ChatScreen.tsx`
 * handled a live decode failure before this issue: nothing is persisted,
 * and `inboxStore` publishes an `'unverifiable'` event so a currently-open
 * `ChatScreen` for that contact can still render its existing "could not be
 * verified" placeholder -- no new UI exists outside `ChatScreen` for this.
 */
import { Store } from '@tanstack/react-store';

import { bundleFromContact, type ContactKeyBundle } from '../api/contactBundle';
import { listContacts, type Contact } from '../api/client';
import { getUserId } from '../api/session';
import { ensureLocalIdentity, type Identity } from '../crypto/identity';
import {
  decodeHandshakeEnvelope,
  decodeRatchetEnvelope,
  HANDSHAKE_ENVELOPE_VERSION,
  RATCHET_ENVELOPE_VERSION,
  type EnvelopeDecodeResult,
} from '../crypto/envelope';
import { loadSession, saveSession } from '../crypto/session';
import { saveMessage } from '../storage/messages';
import { transportStore, type IncomingFrame } from '../transport/store';
import { base64ToBytes, bytesToUtf8 } from '../utils/base64';

/**
 * One decode outcome for a single incoming `message` frame, published for
 * any interested screen (currently only `ChatScreen.tsx`) to observe.
 * `'saved'` carries the recovered plaintext directly (already held in
 * memory as part of decoding; this is not a new place plaintext is
 * persisted -- `saveMessage` below is, per
 * `docs/decisions/0007-local-history-stores-plaintext.md`) so a currently
 * open `ChatScreen` for that contact can render it without re-deriving it
 * from ciphertext or re-querying storage itself.
 */
export type InboxEvent =
  | { seq: number; contactUserId: string; createdAt: string; status: 'saved'; text: string }
  | { seq: number; contactUserId: string; createdAt: string; status: 'unverifiable' };

interface InboxState {
  lastEvent: InboxEvent | null;
}

export const inboxStore = new Store<InboxState>({ lastEvent: null });

let subscription: { unsubscribe: () => void } | null = null;
let lastProcessedFrame: IncomingFrame | null = null;
let contactsCache: Contact[] | null = null;
let contextPromise: Promise<{ identity: Identity; selfUserId: string } | null> | null = null;
let eventSeq = 0;

function emitSaved(contactUserId: string, createdAt: string, text: string): void {
  eventSeq += 1;
  inboxStore.setState(() => ({
    lastEvent: { seq: eventSeq, contactUserId, createdAt, status: 'saved', text },
  }));
}

function emitUnverifiable(contactUserId: string, createdAt: string): void {
  eventSeq += 1;
  inboxStore.setState(() => ({
    lastEvent: { seq: eventSeq, contactUserId, createdAt, status: 'unverifiable' },
  }));
}

/** Loads (and memoizes) this device's own identity + user id, exactly as
 * `ChatScreen.tsx`'s setup effect did before this issue. Not memoized on
 * failure (no session yet) so a later frame -- arriving once a session
 * actually exists -- retries rather than staying stuck. */
async function loadContext(): Promise<{ identity: Identity; selfUserId: string } | null> {
  if (contextPromise === null) {
    contextPromise = (async () => {
      const [selfUserId, identity] = await Promise.all([getUserId(), ensureLocalIdentity()]);
      return selfUserId === null ? null : { identity, selfUserId };
    })();
  }
  const context = await contextPromise;
  if (context === null) {
    contextPromise = null;
  }
  return context;
}

/** Looks up `contactUserId`'s key bundle via `listContacts()`, per the
 * acceptance criteria ("already available app-wide"). The result is cached
 * across frames rather than re-fetched every time; a lookup miss triggers
 * exactly one cache refresh (in case the contact was added after the cache
 * was last populated) before giving up. */
async function findContactBundle(
  contactUserId: string,
  alreadyRefreshed = false
): Promise<ContactKeyBundle | null> {
  if (contactsCache === null) {
    try {
      contactsCache = (await listContacts()).contacts;
    } catch {
      contactsCache = [];
    }
  }

  const contact = contactsCache.find((c) => c.user_id === contactUserId);
  if (contact) {
    return bundleFromContact(contact);
  }
  if (alreadyRefreshed) {
    return null;
  }

  try {
    contactsCache = (await listContacts()).contacts;
  } catch {
    return null;
  }
  return findContactBundle(contactUserId, true);
}

/** Decodes+verifies one live incoming `message` frame from any contact,
 * persisting the advanced ratchet state and the decrypted plaintext on
 * success -- mirrors `ChatScreen.tsx`'s former `handleIncomingEnvelope`
 * exactly, just no longer gated to one specific `contactUserId`. */
async function processMessageFrame(frame: { from: string; body_b64: string }): Promise<void> {
  const createdAt = new Date().toISOString();
  const contactUserId = frame.from;

  const [context, bundle] = await Promise.all([loadContext(), findContactBundle(contactUserId)]);

  if (context === null || bundle === null) {
    emitUnverifiable(contactUserId, createdAt);
    return;
  }
  const { identity, selfUserId } = context;

  const envelope = base64ToBytes(frame.body_b64);
  const version = envelope[0];

  let result: EnvelopeDecodeResult | null = null;
  if (version === HANDSHAKE_ENVELOPE_VERSION) {
    result = decodeHandshakeEnvelope(envelope, {
      contactUserId,
      selfUserId,
      selfX25519SecretKey: identity.x25519SecretKey,
      selfKyberSecretKey: identity.kyberSecretKey,
      senderDilithiumPublicKey: bundle.dilithiumPublicKey,
    });
  } else if (version === RATCHET_ENVELOPE_VERSION) {
    const session = await loadSession(contactUserId);
    if (session !== null) {
      result = decodeRatchetEnvelope(envelope, {
        state: session,
        senderDilithiumPublicKey: bundle.dilithiumPublicKey,
        selfUserId,
        contactUserId,
      });
    }
  }

  if (result === null || !result.ok) {
    emitUnverifiable(contactUserId, createdAt);
    return;
  }

  await saveSession(contactUserId, result.nextState);
  const text = bytesToUtf8(result.plaintext);
  await saveMessage({ contactUserId, direction: 'incoming', body: text, createdAt });
  emitSaved(contactUserId, createdAt, text);
}

/**
 * Starts processing every `message` frame `transportStore` reports, for
 * every contact, for as long as the app session lasts. Safe to call more
 * than once (a no-op while already running). See `../inbox/appSession.ts`
 * for where this is started/stopped.
 */
export function startInboxListener(): void {
  if (subscription !== null) {
    return;
  }
  // Seeded with whatever `lastFrame` already holds so a frame left over
  // from a previous session (e.g. a fast logout/login cycle) isn't
  // reprocessed -- only frames that arrive after this call are new.
  lastProcessedFrame = transportStore.state.lastFrame;
  subscription = transportStore.subscribe(() => {
    const frame = transportStore.state.lastFrame;
    if (frame === null || frame === lastProcessedFrame) {
      return;
    }
    lastProcessedFrame = frame;
    if (frame.type === 'message') {
      void processMessageFrame(frame);
    }
  });
}

/** Stops processing frames and clears every cache, so a later
 * `startInboxListener()` call (e.g. after logging back in as a different
 * user) starts clean. Safe to call more than once. */
export function stopInboxListener(): void {
  subscription?.unsubscribe();
  subscription = null;
  lastProcessedFrame = null;
  contactsCache = null;
  contextPromise = null;
}
