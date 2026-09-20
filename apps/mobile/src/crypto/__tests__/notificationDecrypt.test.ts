import 'react-native-get-random-values';

import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

import { bytesToUtf8, utf8ToBytes } from '../../utils/base64';
import { encodeRatchetEnvelope } from '../envelope';
import {
  notificationDecrypt,
  receiveEnvelopeShared,
  type FetchEnvelope,
  type Lock,
  type SessionStore,
  type StoredDecrypted,
  type StoredSession,
  type WriteResult,
} from '../notificationDecrypt';
import { deriveNextSendingMessageKey, initiateSession, receiveHandshake } from '../session';
import type { RatchetState } from '../session';

const aliceId = 'alice-user-id';
const bobId = 'bob-user-id';

function setup() {
  const aliceDilithium = ml_dsa65.keygen();
  const bobX = x25519.keygen();
  const bobKyber = ml_kem768.keygen();
  const {
    state: aliceInit,
    ea,
    kyberCiphertext,
  } = initiateSession({
    contactUserId: bobId,
    selfUserId: aliceId,
    contactBundle: { x25519PublicKey: bobX.publicKey, kyberPublicKey: bobKyber.publicKey },
  });
  const { state: bobState } = receiveHandshake({
    contactUserId: aliceId,
    selfUserId: bobId,
    ea,
    kyberCiphertext,
    selfX25519SecretKey: bobX.secretKey,
    selfKyberSecretKey: bobKyber.secretKey,
  });
  let aliceState = aliceInit;
  function aliceSends(text: string | Uint8Array): Uint8Array {
    const send = deriveNextSendingMessageKey(aliceState);
    aliceState = send.nextState;
    return encodeRatchetEnvelope({
      header: send.header,
      messageKey: send.messageKey,
      plaintext: typeof text === 'string' ? utf8ToBytes(text) : text,
      selfUserId: aliceId,
      contactUserId: bobId,
      signingSecretKey: aliceDilithium.secretKey,
    });
  }
  return { aliceDilithium, bobState, aliceSends };
}

class FakeStore implements SessionStore {
  sessions = new Map<string, StoredSession>();
  decrypted = new Map<string, StoredDecrypted>();
  events: string[] = [];
  async read(contactId: string) {
    this.events.push('read');
    return this.sessions.get(contactId) ?? null;
  }
  async write(
    contactId: string,
    state: RatchetState,
    expectedGeneration: number,
    decrypted?: { messageId: string } & StoredDecrypted
  ): Promise<WriteResult> {
    this.events.push('write');
    const cur = this.sessions.get(contactId);
    if ((cur?.generation ?? 0) !== expectedGeneration) return { ok: false, reason: 'stale' };
    const generation = expectedGeneration + 1;
    this.sessions.set(contactId, { state, generation });
    if (decrypted) this.decrypted.set(`${contactId}:${decrypted.messageId}`, {
        envelopeDigest: decrypted.envelopeDigest,
        plaintext: decrypted.plaintext,
      });
    return { ok: true, generation };
  }
  async getDecrypted(contactId: string, messageId: string) {
    return this.decrypted.get(`${contactId}:${messageId}`) ?? null;
  }
  async deleteDecrypted(contactId: string, messageId: string) {
    this.decrypted.delete(`${contactId}:${messageId}`);
  }
}

class FakeLock implements Lock {
  held = false;
  timeout = false;
  events: string[];
  constructor(events: string[]) {
    this.events = events;
  }
  async acquire() {
    if (this.timeout) return null;
    this.events.push('acquire');
    this.held = true;
    return async () => {
      this.events.push('release');
      this.held = false;
    };
  }
}

function build(envelope: Uint8Array | null | 'fail', messageId = 'm1') {
  const { aliceDilithium, bobState, aliceSends } = setup();
  const store = new FakeStore();
  store.sessions.set(aliceId, { state: bobState, generation: 1 });
  const lock = new FakeLock(store.events);
  const fetchEnvelope: FetchEnvelope = async () =>
    envelope === 'fail'
      ? { ok: false }
      : { ok: true, messageId, envelope: envelope ?? aliceSends('hello bob') };
  const deps = {
    sessionStore: store as SessionStore,
    lock: lock as Lock,
    fetchEnvelope,
    selfUserId: bobId,
    resolveSenderKey: async () => aliceDilithium.publicKey,
  };
  return { store, lock, deps, aliceSends, bobState };
}

describe('notificationDecrypt', () => {
  it('decrypts the queued envelope into preview text and persists state', async () => {
    const { store, deps } = build(null);
    const r = await notificationDecrypt(aliceId, deps);
    expect(r).toEqual({ ok: true, senderUserId: aliceId, previewText: 'hello bob' });
    expect(store.sessions.get(aliceId)?.generation).toBe(2);
    expect(store.sessions.get(aliceId)?.state.receiveMessageNumber).toBe(1);
  });

  it('fails with no_session when there is no session', async () => {
    const { store, deps } = build(null);
    store.sessions.clear();
    expect(await notificationDecrypt(aliceId, deps)).toEqual({ ok: false, reason: 'no_session' });
  });

  it('fails with fetch_failed and leaves state alone', async () => {
    const { store, deps } = build('fail');
    expect(await notificationDecrypt(aliceId, deps)).toEqual({
      ok: false,
      reason: 'fetch_failed',
    });
    expect(store.sessions.get(aliceId)?.generation).toBe(1);
  });

  it('reports a handshake (0x02) envelope as unsupported, leaving state alone', async () => {
    const { store, deps } = build(new Uint8Array(4000).fill(2));
    expect(await notificationDecrypt(aliceId, deps)).toEqual({
      ok: false,
      reason: 'unsupported_envelope',
    });
    expect(store.sessions.get(aliceId)?.generation).toBe(1);
  });

  it('fails with corrupt_envelope on garbage bytes', async () => {
    const { store, deps } = build(new Uint8Array([1, 2, 3]));
    expect(await notificationDecrypt(aliceId, deps)).toEqual({
      ok: false,
      reason: 'corrupt_envelope',
    });
    expect(store.sessions.get(aliceId)?.generation).toBe(1);
  });

  it('fails with decrypt_failure on a tampered envelope without persisting', async () => {
    const { aliceSends } = setup();
    const env = aliceSends('x');
    env[60] ^= 0xff;
    const { store, deps } = build(env);
    const r = await notificationDecrypt(aliceId, deps);
    expect(r).toEqual({ ok: false, reason: 'decrypt_failure' });
    expect(store.sessions.get(aliceId)?.generation).toBe(1);
  });

  it('fails with lock_timeout when the lock cannot be acquired', async () => {
    const { lock, deps } = build(null);
    lock.timeout = true;
    expect(await notificationDecrypt(aliceId, deps)).toEqual({
      ok: false,
      reason: 'lock_timeout',
    });
  });

  it('acquires the lock before reading and releases after writing (success)', async () => {
    const { store, deps } = build(null);
    await notificationDecrypt(aliceId, deps);
    expect(store.events).toEqual(['acquire', 'read', 'write', 'release']);
  });

  it('releases the lock on failure', async () => {
    const { store, deps } = build(new Uint8Array([1, 2, 3]));
    await notificationDecrypt(aliceId, deps);
    expect(store.events[0]).toBe('acquire');
    expect(store.events[store.events.length - 1]).toBe('release');
  });

  it('releases the lock and returns a typed failure when the store throws', async () => {
    const { store, lock, deps } = build(null);
    store.read = async () => {
      throw new Error('disk');
    };
    const r = await notificationDecrypt(aliceId, deps);
    expect(r).toEqual({ ok: false, reason: 'storage_error' });
    expect(lock.held).toBe(false);
  });

  it('rejects a stale-generation write without overwriting newer state', async () => {
    const { store, deps, bobState } = build(null);
    const realWrite = store.write.bind(store);
    // Simulate another writer sneaking in between read and write.
    store.write = async (c, s, g, d) => {
      store.sessions.set(c, { state: bobState, generation: 7 });
      return realWrite(c, s, g, d);
    };
    const r = await notificationDecrypt(aliceId, deps);
    expect(r).toEqual({ ok: false, reason: 'state_conflict' });
    expect(store.sessions.get(aliceId)).toEqual({ state: bobState, generation: 7 });
    expect(store.decrypted.size).toBe(0);
  });
});

describe('interleaved notification decrypt and app receive', () => {
  it('main app receive after notification decrypt succeeds with correct plaintext', async () => {
    const { store, deps, aliceSends } = build(null);
    const env = aliceSends('secret');
    const deps2 = {
      ...deps,
      fetchEnvelope: async () => ({ ok: true as const, messageId: 'm9', envelope: env }),
    };
    const n = await notificationDecrypt(aliceId, deps2);
    expect(n).toMatchObject({ ok: true, previewText: 'secret' });
    const gen = store.sessions.get(aliceId)?.generation;

    const app = await receiveEnvelopeShared(aliceId, 'm9', env, deps2);
    expect(app.ok).toBe(true);
    if (!app.ok) throw new Error('expected ok');
    expect(bytesToUtf8(app.plaintext)).toBe('secret');
    expect(store.sessions.get(aliceId)?.generation).toBe(gen);
    expect(store.sessions.get(aliceId)?.state.receiveMessageNumber).toBe(1);
  });

  it('app receive first, then notification decrypt: no double advance, same preview', async () => {
    const { store, deps, aliceSends } = build(null);
    const env = aliceSends('first');
    const deps2 = {
      ...deps,
      fetchEnvelope: async () => ({ ok: true as const, messageId: 'm5', envelope: env }),
    };
    const app = await receiveEnvelopeShared(aliceId, 'm5', env, deps2);
    expect(app.ok).toBe(true);
    const n = await notificationDecrypt(aliceId, deps2);
    expect(n).toMatchObject({ ok: true, previewText: 'first' });
    expect(store.sessions.get(aliceId)?.state.receiveMessageNumber).toBe(1);
  });

  it('concurrent runs serialize through the lock and end with identical state', async () => {
    const { store, deps, aliceSends } = build(null);
    const env = aliceSends('race');
    let tail: Promise<void> = Promise.resolve();
    const mutexLock: Lock = {
      acquire: () =>
        new Promise((resolve) => {
          const prev = tail;
          let done!: () => void;
          tail = new Promise<void>((r) => (done = r));
          prev.then(() => resolve(async () => done()));
        }),
    };
    const d = {
      ...deps,
      lock: mutexLock,
      fetchEnvelope: async () => ({ ok: true as const, messageId: 'mr', envelope: env }),
    };
    const [a, b] = await Promise.all([
      notificationDecrypt(aliceId, d),
      receiveEnvelopeShared(aliceId, 'mr', env, d),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const s = store.sessions.get(aliceId)!;
    expect(s.state.receiveMessageNumber).toBe(1);
    expect(s.generation).toBe(2);
  });
});

describe('cache binding, byte-exact plaintext, stale-write recheck', () => {
  it('B1: cache hit with a different envelope under a known messageId does not return stored plaintext', async () => {
    const b = build(null);
    const env = b.aliceSends('genuine');
    const first = await receiveEnvelopeShared(aliceId, 'k', env, b.deps);
    expect(first.ok).toBe(true);
    const garbage = new Uint8Array(4000).fill(9);
    const viaNotification = await notificationDecrypt(aliceId, {
      ...b.deps,
      fetchEnvelope: async () => ({ ok: true as const, messageId: 'k', envelope: garbage }),
    });
    expect(viaNotification).toEqual({ ok: false, reason: 'corrupt_envelope' });
    const viaApp = await receiveEnvelopeShared(aliceId, 'k', garbage, b.deps);
    expect(viaApp).toEqual({ ok: false, reason: 'corrupt_envelope' });
  });

  it('B2: non-UTF-8 body round-trips byte-exact through the shared store', async () => {
    const b = build(null);
    const env = b.aliceSends(Uint8Array.of(0xff, 0x80, 0x00));
    const first = await receiveEnvelopeShared(aliceId, 'bin', env, b.deps);
    expect(first.ok && Array.from(first.plaintext)).toEqual([0xff, 0x80, 0x00]);
    const second = await receiveEnvelopeShared(aliceId, 'bin', env, b.deps);
    expect(second.ok && Array.from(second.plaintext)).toEqual([0xff, 0x80, 0x00]);
  });

  it('B3: deleteDecrypted removes the record', async () => {
    const b = build(null);
    const env = b.aliceSends('x');
    await receiveEnvelopeShared(aliceId, 'd', env, b.deps);
    expect(await b.store.getDecrypted(aliceId, 'd')).not.toBeNull();
    await b.store.deleteDecrypted(aliceId, 'd');
    expect(await b.store.getDecrypted(aliceId, 'd')).toBeNull();
  });

  it('B4: stale write rechecks the cache and returns the winner plaintext', async () => {
    const b = build(null);
    const env = b.aliceSends('winner');
    const store = b.store;
    const realWrite = store.write.bind(store);
    let first = true;
    store.write = async (c, st, g, d) => {
      if (first) {
        first = false;
        await realWrite(c, st, g, d); // the other process wins the race
      }
      return realWrite(c, st, g, d); // ours is now stale
    };
    const r = await receiveEnvelopeShared(aliceId, 'w', env, b.deps);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(bytesToUtf8(r.plaintext)).toBe('winner');
  });
});
