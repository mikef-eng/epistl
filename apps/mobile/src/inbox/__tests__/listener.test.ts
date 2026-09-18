/**
 * Regression coverage for issue #165's app-level global inbox listener: the
 * old `ChatScreen.tsx`-only frame handling silently dropped a live message
 * from any contact other than whichever one the currently-open chat
 * happened to be for. These tests drive real PQXDH handshake envelopes
 * (`../../crypto/session`/`../../crypto/envelope`, the same primitives
 * `../../crypto/__tests__/envelope.test.ts` exercises directly) through
 * `../listener.ts` via `transportStore.setState` -- never through
 * `ChatScreen.tsx`, which is the point: persistence must not depend on any
 * screen being mounted at all.
 *
 * `expo-sqlite` is mocked with a real (in-memory) `node:sqlite` engine, the
 * same approach `../../storage/__tests__/messages.test.ts` uses, so
 * `getMessages`/`getConversationSummaries` assertions below exercise real
 * SQLite semantics. `expo-secure-store` is mocked with a plain in-memory
 * map (`../../crypto/__tests__/session.test.ts`'s approach) so
 * `loadSession`/`saveSession` run for real against it. `../../transport/quic`
 * is mocked because `../../transport/store` imports it, and it in turn pulls
 * in the native `quic-relay-client` TurboModule bindings that don't exist
 * under Jest -- mirroring `../../transport/__tests__/store.test.ts`.
 */
import 'react-native-get-random-values';

import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

import type { Contact } from '../../api/client';

jest.mock('expo-sqlite', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- inside a jest.mock factory, which must be synchronous.
  const { DatabaseSync: RealDatabaseSync } = require('node:sqlite');
  const globalScope = globalThis as unknown as {
    __mockSqliteDatabases?: Map<string, InstanceType<typeof RealDatabaseSync>>;
  };
  globalScope.__mockSqliteDatabases ??= new Map();
  const databases = globalScope.__mockSqliteDatabases;

  function isReadStatement(source: string): boolean {
    const match = /^\s*([a-zA-Z]+)/.exec(source);
    const keyword = (match?.[1] ?? '').toUpperCase();
    return ['SELECT', 'PRAGMA', 'WITH', 'EXPLAIN'].includes(keyword);
  }

  function wrap(raw: InstanceType<typeof RealDatabaseSync>) {
    return {
      execSync: (source: string) => {
        raw.exec(source);
      },
      getAllSync: (source: string, params: unknown[] = []) => {
        return raw.prepare(source).all(...params);
      },
      prepareSync: (source: string) => {
        const stmt = raw.prepare(source);
        return {
          executeSync: (params: unknown[] = []) => {
            if (isReadStatement(source)) {
              const rows = stmt.all(...params);
              return {
                changes: 0,
                lastInsertRowId: 0,
                getAllSync: () => rows,
                getFirstSync: () => rows[0],
              };
            }
            const info = stmt.run(...params);
            return {
              changes: info.changes,
              lastInsertRowId: Number(info.lastInsertRowid),
              getAllSync: () => [],
              getFirstSync: () => undefined,
            };
          },
          executeForRawResultSync: (params: unknown[] = []) => {
            const rows = stmt.all(...params) as Record<string, unknown>[];
            return { getAllSync: () => rows.map((row) => Object.values(row)) };
          },
        };
      },
      closeSync: () => {},
    };
  }

  function openDatabaseSync(name: string) {
    let raw = databases.get(name);
    if (!raw) {
      raw = new RealDatabaseSync(':memory:');
      databases.set(name, raw);
    }
    return wrap(raw);
  }

  return { openDatabaseSync };
});

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

const mockConnectQuic = jest.fn();
jest.mock('../../transport/quic', () => ({
  connectQuic: (...args: unknown[]) => mockConnectQuic(...args),
}));

jest.mock('../../api/client', () => ({
  API_BASE_URL: 'http://localhost:0',
  listContacts: jest.fn(),
}));

jest.mock('../../api/session', () => ({
  getUserId: jest.fn(),
}));

jest.mock('../../crypto/identity', () => ({
  ensureLocalIdentity: jest.fn(),
}));

// eslint-disable-next-line import/first -- must follow the jest.mock calls above.
import { listContacts } from '../../api/client';
// eslint-disable-next-line import/first
import { getUserId } from '../../api/session';
// eslint-disable-next-line import/first
import { encodeHandshakeEnvelope } from '../../crypto/envelope';
// eslint-disable-next-line import/first
import { ensureLocalIdentity, type Identity } from '../../crypto/identity';
// eslint-disable-next-line import/first
import { deriveNextSendingMessageKey, initiateSession } from '../../crypto/session';
// eslint-disable-next-line import/first
import { getConversationSummaries, getMessages } from '../../storage/messages';
// eslint-disable-next-line import/first
import { transportStore } from '../../transport/store';
// eslint-disable-next-line import/first
import { base64ToBytes, bytesToBase64, utf8ToBytes } from '../../utils/base64';
// eslint-disable-next-line import/first
import { inboxStore, startInboxListener, stopInboxListener, type InboxEvent } from '../listener';

const mockListContacts = listContacts as jest.Mock;
const mockGetUserId = getUserId as jest.Mock;
const mockEnsureLocalIdentity = ensureLocalIdentity as jest.Mock;

const SELF_USER_ID = 'self-user-id';

const selfX25519 = x25519.keygen();
const selfKyber = ml_kem768.keygen();
const selfDilithium = ml_dsa65.keygen();
const selfIdentity: Identity = {
  x25519PublicKey: selfX25519.publicKey,
  x25519SecretKey: selfX25519.secretKey,
  kyberPublicKey: selfKyber.publicKey,
  kyberSecretKey: selfKyber.secretKey,
  dilithiumPublicKey: selfDilithium.publicKey,
  dilithiumSecretKey: selfDilithium.secretKey,
  prekeySignature: new Uint8Array(1),
};

interface TestContact {
  userId: string;
  x25519Keys: ReturnType<typeof x25519.keygen>;
  kyberKeys: ReturnType<typeof ml_kem768.keygen>;
  dilithium: ReturnType<typeof ml_dsa65.keygen>;
}

function makeTestContact(userId: string): TestContact {
  return {
    userId,
    x25519Keys: x25519.keygen(),
    kyberKeys: ml_kem768.keygen(),
    dilithium: ml_dsa65.keygen(),
  };
}

function contactRecord(contact: TestContact): Contact {
  return {
    user_id: contact.userId,
    email: `${contact.userId}@example.com`,
    username: contact.userId,
    added_at: '2024-01-01T00:00:00.000Z',
    x25519_public_key_b64: bytesToBase64(contact.x25519Keys.publicKey),
    kyber_public_key_b64: bytesToBase64(contact.kyberKeys.publicKey),
    dilithium_public_key_b64: bytesToBase64(contact.dilithium.publicKey),
    prekey_signature_b64: bytesToBase64(new Uint8Array(1)),
  };
}

/** Encodes a brand-new-session handshake envelope from `contact` to the
 * device under test (`SELF_USER_ID`), mirroring
 * `envelope.test.ts`'s `performHandshake` but fixed to this file's "self"
 * identity as the recipient. */
function encodeHandshakeFrom(contact: TestContact, plaintext: string): string {
  const initiated = initiateSession({
    contactUserId: SELF_USER_ID,
    selfUserId: contact.userId,
    contactBundle: {
      x25519PublicKey: selfIdentity.x25519PublicKey,
      kyberPublicKey: selfIdentity.kyberPublicKey,
    },
  });
  const send0 = deriveNextSendingMessageKey(initiated.state);
  const envelope = encodeHandshakeEnvelope({
    ea: initiated.ea,
    kyberCiphertext: initiated.kyberCiphertext,
    messageKey: send0.messageKey,
    plaintext: utf8ToBytes(plaintext),
    selfUserId: contact.userId,
    contactUserId: SELF_USER_ID,
    signingSecretKey: contact.dilithium.secretKey,
  });
  return bytesToBase64(envelope);
}

function deliverFrame(fromUserId: string, bodyB64: string): void {
  transportStore.setState((s) => ({
    ...s,
    lastFrame: { type: 'message', from: fromUserId, body_b64: bodyB64 },
  }));
}

/** Resolves with the next `inboxStore` event published after this is
 * called -- `startInboxListener`'s processing is asynchronous (identity,
 * contacts, and secure-store I/O), so tests await this instead of a fixed
 * timer. */
function nextInboxEvent(): Promise<InboxEvent> {
  return new Promise((resolve) => {
    const subscription = inboxStore.subscribe(() => {
      const event = inboxStore.state.lastEvent;
      if (event) {
        subscription.unsubscribe();
        resolve(event);
      }
    });
  });
}

describe('inbox listener', () => {
  beforeEach(() => {
    transportStore.setState(() => ({ status: 'disconnected', activeTransport: null, lastFrame: null }));
    inboxStore.setState(() => ({ lastEvent: null }));
    mockGetUserId.mockResolvedValue(SELF_USER_ID);
    mockEnsureLocalIdentity.mockResolvedValue(selfIdentity);
    mockListContacts.mockResolvedValue({ contacts: [] });
  });

  afterEach(() => {
    stopInboxListener();
    jest.clearAllMocks();
  });

  it('decodes and persists incoming messages from two different contacts, regardless of which (if any) chat is open', async () => {
    const contactA = makeTestContact('contact-a');
    const contactB = makeTestContact('contact-b');
    mockListContacts.mockResolvedValue({ contacts: [contactRecord(contactA), contactRecord(contactB)] });

    startInboxListener();

    const firstEvent = nextInboxEvent();
    deliverFrame(contactA.userId, encodeHandshakeFrom(contactA, 'hi from A'));
    await firstEvent;

    const secondEvent = nextInboxEvent();
    deliverFrame(contactB.userId, encodeHandshakeFrom(contactB, 'hi from B'));
    await secondEvent;

    const aRows = await getMessages(contactA.userId);
    const bRows = await getMessages(contactB.userId);
    expect(aRows.map((r) => r.body)).toEqual(['hi from A']);
    expect(bRows.map((r) => r.body)).toEqual(['hi from B']);
    expect(aRows[0].direction).toBe('incoming');
    expect(bRows[0].direction).toBe('incoming');
  });

  it('persists a message even when no ChatScreen is mounted at all', async () => {
    const contact = makeTestContact('contact-solo');
    mockListContacts.mockResolvedValue({ contacts: [contactRecord(contact)] });

    startInboxListener();

    const event = nextInboxEvent();
    deliverFrame(contact.userId, encodeHandshakeFrom(contact, 'no chat open'));
    const resolved = await event;

    expect(resolved.status).toBe('saved');
    const rows = await getMessages(contact.userId);
    expect(rows.map((r) => r.body)).toEqual(['no chat open']);
  });

  it('reflects a message received via the listener in getConversationSummaries()', async () => {
    const contact = makeTestContact('contact-summary');
    mockListContacts.mockResolvedValue({ contacts: [contactRecord(contact)] });

    startInboxListener();

    const event = nextInboxEvent();
    deliverFrame(contact.userId, encodeHandshakeFrom(contact, 'summary me'));
    await event;

    const summaries = await getConversationSummaries();
    const summary = summaries.find((s) => s.contactUserId === contact.userId);
    expect(summary).toBeDefined();
    expect(summary?.lastBody).toBe('summary me');
    expect(summary?.hasUnread).toBe(true);
  });

  it('does not persist anything and emits an unverifiable event on a signature failure', async () => {
    const contact = makeTestContact('contact-bad-sig');
    mockListContacts.mockResolvedValue({ contacts: [contactRecord(contact)] });

    startInboxListener();

    const bodyB64 = encodeHandshakeFrom(contact, 'tampered');
    const tampered = base64ToBytes(bodyB64);
    // Flip a byte inside the signed portion so signature verification fails
    // without otherwise corrupting the envelope's structure.
    tampered[10] ^= 0xff;

    const event = nextInboxEvent();
    deliverFrame(contact.userId, bytesToBase64(tampered));
    const resolved = await event;

    expect(resolved.status).toBe('unverifiable');
    const rows = await getMessages(contact.userId);
    expect(rows).toEqual([]);
  });

  it('treats a message from an unknown (non-contact) sender as unverifiable', async () => {
    mockListContacts.mockResolvedValue({ contacts: [] });
    const stranger = makeTestContact('stranger');

    startInboxListener();

    const event = nextInboxEvent();
    deliverFrame(stranger.userId, encodeHandshakeFrom(stranger, 'hi'));
    const resolved = await event;

    expect(resolved.status).toBe('unverifiable');
    const rows = await getMessages(stranger.userId);
    expect(rows).toEqual([]);
  });

  it('decodes/persists a given live frame at most once', async () => {
    const contact = makeTestContact('contact-once');
    mockListContacts.mockResolvedValue({ contacts: [contactRecord(contact)] });

    startInboxListener();

    const event = nextInboxEvent();
    deliverFrame(contact.userId, encodeHandshakeFrom(contact, 'only once'));
    await event;

    const seqAfterFirst = inboxStore.state.lastEvent?.seq;

    // A state change that does not touch `lastFrame` (e.g. a status flip)
    // must not cause the same frame to be reprocessed.
    transportStore.setState((s) => ({ ...s, status: 'connected', activeTransport: 'ws' }));
    // Give any (incorrect) reprocessing a chance to run before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rows = await getMessages(contact.userId);
    expect(rows).toHaveLength(1);
    expect(inboxStore.state.lastEvent?.seq).toBe(seqAfterFirst);
  });

  it('startInboxListener is a no-op when already running (no double subscription)', async () => {
    const contact = makeTestContact('contact-idempotent-start');
    mockListContacts.mockResolvedValue({ contacts: [contactRecord(contact)] });

    startInboxListener();
    startInboxListener();

    const event = nextInboxEvent();
    deliverFrame(contact.userId, encodeHandshakeFrom(contact, 'single subscription'));
    await event;

    const rows = await getMessages(contact.userId);
    expect(rows).toHaveLength(1);
  });
});
