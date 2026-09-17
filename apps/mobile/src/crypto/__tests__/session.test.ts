import 'react-native-get-random-values';

import * as SecureStore from 'expo-secure-store';
import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { PREKEY_SIGNATURE_CONTEXT } from '../identity';
import {
  clearAllSessions,
  deriveNextReceivingMessageKey,
  deriveNextSendingMessageKey,
  initiateSession,
  KDF_CK,
  KDF_RK,
  loadSession,
  receiveHandshake,
  RatchetState,
  saveSession,
  verifyPrekeyBundle,
} from '../session';

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

function generateStaticKeys() {
  return {
    x25519: x25519.keygen(),
    kyber: ml_kem768.keygen(),
  };
}

function unwrapAccepted<T>(result: T | { rejected: true }): T {
  if (result !== null && typeof result === 'object' && 'rejected' in result) {
    throw new Error('expected an accepted receive result, got { rejected: true }');
  }
  return result as T;
}

describe('KDF_RK', () => {
  it('derives a distinct 32-byte root key and 32-byte chain key', () => {
    const rootKey = new Uint8Array(32).fill(1);
    const dhOutput = new Uint8Array(32).fill(2);

    const { rootKey: nextRootKey, chainKey } = KDF_RK(rootKey, dhOutput);

    expect(nextRootKey.length).toBe(32);
    expect(chainKey.length).toBe(32);
    expect(nextRootKey).not.toEqual(chainKey);
    expect(nextRootKey).not.toEqual(rootKey);
  });

  it('is deterministic for the same inputs', () => {
    const rootKey = new Uint8Array(32).fill(1);
    const dhOutput = new Uint8Array(32).fill(2);

    expect(KDF_RK(rootKey, dhOutput)).toEqual(KDF_RK(rootKey, dhOutput));
  });

  it('produces different output for a different root key', () => {
    const dhOutput = new Uint8Array(32).fill(2);
    const a = KDF_RK(new Uint8Array(32).fill(1), dhOutput);
    const b = KDF_RK(new Uint8Array(32).fill(9), dhOutput);

    expect(a.rootKey).not.toEqual(b.rootKey);
    expect(a.chainKey).not.toEqual(b.chainKey);
  });
});

describe('KDF_CK', () => {
  it('derives a distinct next chain key and message key', () => {
    const chainKey = new Uint8Array(32).fill(7);

    const { nextChainKey, messageKey } = KDF_CK(chainKey);

    expect(nextChainKey.length).toBe(32);
    expect(messageKey.length).toBe(32);
    expect(nextChainKey).not.toEqual(messageKey);
    expect(nextChainKey).not.toEqual(chainKey);
  });

  it('is deterministic for the same input', () => {
    const chainKey = new Uint8Array(32).fill(7);

    expect(KDF_CK(chainKey)).toEqual(KDF_CK(chainKey));
  });
});

describe('verifyPrekeyBundle', () => {
  it('returns true for a correctly signed bundle', () => {
    const dilithium = ml_dsa65.keygen();
    const x25519Keys = x25519.keygen();
    const kyber = ml_kem768.keygen();
    const message = concatBytes(
      utf8ToBytes(PREKEY_SIGNATURE_CONTEXT),
      x25519Keys.publicKey,
      kyber.publicKey
    );
    const prekeySignature = ml_dsa65.sign(message, dilithium.secretKey);

    expect(
      verifyPrekeyBundle({
        x25519PublicKey: x25519Keys.publicKey,
        kyberPublicKey: kyber.publicKey,
        dilithiumPublicKey: dilithium.publicKey,
        prekeySignature,
      })
    ).toBe(true);
  });

  it('returns false (not a throw) when the signature does not match the keys', () => {
    const dilithium = ml_dsa65.keygen();
    const x25519Keys = x25519.keygen();
    const otherX25519Keys = x25519.keygen();
    const kyber = ml_kem768.keygen();
    const message = concatBytes(
      utf8ToBytes(PREKEY_SIGNATURE_CONTEXT),
      x25519Keys.publicKey,
      kyber.publicKey
    );
    const prekeySignature = ml_dsa65.sign(message, dilithium.secretKey);

    expect(
      verifyPrekeyBundle({
        x25519PublicKey: otherX25519Keys.publicKey,
        kyberPublicKey: kyber.publicKey,
        dilithiumPublicKey: dilithium.publicKey,
        prekeySignature,
      })
    ).toBe(false);
  });

  it('returns false (not a throw) for garbage/malformed signature bytes', () => {
    const dilithium = ml_dsa65.keygen();
    const x25519Keys = x25519.keygen();
    const kyber = ml_kem768.keygen();

    expect(() =>
      verifyPrekeyBundle({
        x25519PublicKey: x25519Keys.publicKey,
        kyberPublicKey: kyber.publicKey,
        dilithiumPublicKey: dilithium.publicKey,
        prekeySignature: new Uint8Array([1, 2, 3]),
      })
    ).not.toThrow();

    expect(
      verifyPrekeyBundle({
        x25519PublicKey: x25519Keys.publicKey,
        kyberPublicKey: kyber.publicKey,
        dilithiumPublicKey: dilithium.publicKey,
        prekeySignature: new Uint8Array([1, 2, 3]),
      })
    ).toBe(false);
  });
});

describe('handshake + ratchet', () => {
  const aliceUserId = 'alice-user-id';
  const bobUserId = 'bob-user-id';

  function performHandshake() {
    const bobKeys = generateStaticKeys();

    const {
      state: aliceState,
      ea,
      kyberCiphertext,
    } = initiateSession({
      contactUserId: bobUserId,
      selfUserId: aliceUserId,
      contactBundle: {
        x25519PublicKey: bobKeys.x25519.publicKey,
        kyberPublicKey: bobKeys.kyber.publicKey,
      },
    });

    const { state: bobState } = receiveHandshake({
      contactUserId: aliceUserId,
      selfUserId: bobUserId,
      ea,
      kyberCiphertext,
      selfX25519SecretKey: bobKeys.x25519.secretKey,
      selfKyberSecretKey: bobKeys.kyber.secretKey,
    });

    return { aliceState, bobState, ea };
  }

  it('produces sensible initial state shapes for both roles', () => {
    const { aliceState, bobState, ea } = performHandshake();

    expect(aliceState.dhrPublicKey).toBeNull();
    expect(aliceState.sendingChainKey).not.toBeNull();
    expect(aliceState.receivingChainKey).toBeNull();
    expect(aliceState.sendMessageNumber).toBe(0);
    expect(aliceState.receiveMessageNumber).toBe(0);
    expect(aliceState.previousSendingChainLength).toBe(0);
    expect(aliceState.dhsPublicKey).toEqual(ea);

    // Bob's first inbound message already ran the generic DH-ratchet-step
    // logic (his dhrPublicKey starts null), so unlike Alice he already has
    // both a sending and a receiving chain, and his dhr is set to `ea`.
    expect(bobState.dhrPublicKey).toEqual(ea);
    expect(bobState.sendingChainKey).not.toBeNull();
    expect(bobState.receivingChainKey).not.toBeNull();
    expect(bobState.sendMessageNumber).toBe(0);
    expect(bobState.receiveMessageNumber).toBe(0);
    // Bob's send side used a *fresh* ephemeral key generated during the
    // ratchet step, not his long-lived static X25519 key.
    expect(bobState.dhsPublicKey).not.toEqual(ea);
  });

  it('derives byte-identical message-0 keys in each direction right after the handshake', () => {
    const { aliceState, bobState } = performHandshake();

    const aliceSend0 = deriveNextSendingMessageKey(aliceState);
    const bobReceive0 = unwrapAccepted(
      deriveNextReceivingMessageKey(
        bobState,
        aliceSend0.header.dhPublicKey,
        aliceSend0.header.messageNumber
      )
    );
    expect(bobReceive0.messageKey).toEqual(aliceSend0.messageKey);

    const bobSend0 = deriveNextSendingMessageKey(bobState);
    const aliceReceive0 = unwrapAccepted(
      deriveNextReceivingMessageKey(
        aliceState,
        bobSend0.header.dhPublicKey,
        bobSend0.header.messageNumber
      )
    );
    expect(aliceReceive0.messageKey).toEqual(bobSend0.messageKey);
  });

  it('continues deriving matching keys across many messages, including a sender-change DH ratchet step', () => {
    let { aliceState, bobState } = performHandshake();

    function aliceSends() {
      const send = deriveNextSendingMessageKey(aliceState);
      aliceState = send.nextState;
      const receive = unwrapAccepted(
        deriveNextReceivingMessageKey(bobState, send.header.dhPublicKey, send.header.messageNumber)
      );
      bobState = receive.nextState;
      expect(receive.messageKey).toEqual(send.messageKey);
    }

    function bobSends() {
      const send = deriveNextSendingMessageKey(bobState);
      bobState = send.nextState;
      const receive = unwrapAccepted(
        deriveNextReceivingMessageKey(
          aliceState,
          send.header.dhPublicKey,
          send.header.messageNumber
        )
      );
      aliceState = receive.nextState;
      expect(receive.messageKey).toEqual(send.messageKey);
    }

    // Alice sends twice in a row on her initial chain (no ratchet step).
    aliceSends();
    aliceSends();

    const aliceDhBeforeBobReplies = aliceState.dhsPublicKey;

    // Bob replies for the first time. This is a sender change: Bob's send
    // uses the fresh key he generated inside receiveHandshake, which Alice
    // has never seen as a `dhr`, so Alice's receive triggers a DH ratchet
    // step (regenerating her own sending chain and dhs key too).
    bobSends();
    expect(aliceState.dhrPublicKey).not.toEqual(aliceDhBeforeBobReplies);
    expect(aliceState.dhsPublicKey).not.toEqual(aliceDhBeforeBobReplies);
    expect(aliceState.sendMessageNumber).toBe(0);
    expect(aliceState.previousSendingChainLength).toBe(2);

    // Bob sends again on the same (unratcheted) chain.
    bobSends();

    const bobDhBeforeAliceReplies = bobState.dhsPublicKey;

    // Alice replies using her freshly-ratcheted key: another sender change,
    // this time triggering Bob's DH ratchet step.
    aliceSends();
    expect(bobState.dhrPublicKey).not.toEqual(bobDhBeforeAliceReplies);
    expect(bobState.dhsPublicKey).not.toEqual(bobDhBeforeAliceReplies);
    expect(bobState.sendMessageNumber).toBe(0);
    expect(bobState.previousSendingChainLength).toBe(2);

    // A few more messages back and forth on the newly-ratcheted chains.
    bobSends();
    aliceSends();
    aliceSends();
  });

  it('rejects a message presented with an unexpected message number, without throwing or mutating state', () => {
    const { aliceState, bobState } = performHandshake();

    const send0 = deriveNextSendingMessageKey(aliceState);
    const receive0 = unwrapAccepted(
      deriveNextReceivingMessageKey(bobState, send0.header.dhPublicKey, send0.header.messageNumber)
    );

    const snapshotBefore: RatchetState = JSON.parse(
      JSON.stringify(receive0.nextState, (_key, value) =>
        value instanceof Uint8Array ? Array.from(value) : value
      )
    );

    let result: ReturnType<typeof deriveNextReceivingMessageKey> | undefined;
    expect(() => {
      result = deriveNextReceivingMessageKey(receive0.nextState, send0.header.dhPublicKey, 5);
    }).not.toThrow();

    expect(result).toEqual({ rejected: true });

    const snapshotAfter: RatchetState = JSON.parse(
      JSON.stringify(receive0.nextState, (_key, value) =>
        value instanceof Uint8Array ? Array.from(value) : value
      )
    );
    expect(snapshotAfter).toEqual(snapshotBefore);
  });
});

describe('loadSession / saveSession', () => {
  const contactUserId = 'contact-user-id';

  beforeEach(() => {
    mockSecureStore.__store.clear();
    jest.clearAllMocks();
  });

  it('returns null when no session has been saved', async () => {
    expect(await loadSession(contactUserId)).toBeNull();
  });

  it('round-trips a full RatchetState (including nullable fields) byte-for-byte', async () => {
    const bobKeys = generateStaticKeys();
    const { state } = initiateSession({
      contactUserId,
      selfUserId: 'self-user-id',
      contactBundle: {
        x25519PublicKey: bobKeys.x25519.publicKey,
        kyberPublicKey: bobKeys.kyber.publicKey,
      },
    });

    await saveSession(contactUserId, state);
    const loaded = await loadSession(contactUserId);

    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(state);
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
      `epistl.ratchet_session.${contactUserId}`,
      expect.any(String)
    );
  });

  it('round-trips a state with non-null dhr/sending/receiving chain fields', async () => {
    const bobKeys = generateStaticKeys();
    const { ea, kyberCiphertext } = initiateSession({
      contactUserId,
      selfUserId: 'self-user-id',
      contactBundle: {
        x25519PublicKey: bobKeys.x25519.publicKey,
        kyberPublicKey: bobKeys.kyber.publicKey,
      },
    });
    // Bob's post-handshake state has already run through the generic
    // DH-ratchet-step logic, so it exercises the non-null dhr/sending/
    // receiving fields that Alice's initial state (tested above) leaves null.
    const { state } = receiveHandshake({
      contactUserId: 'self-user-id',
      selfUserId: contactUserId,
      ea,
      kyberCiphertext,
      selfX25519SecretKey: bobKeys.x25519.secretKey,
      selfKyberSecretKey: bobKeys.kyber.secretKey,
    });

    await saveSession(contactUserId, state);
    const loaded = await loadSession(contactUserId);

    expect(loaded).toEqual(state);
  });
});

describe('clearAllSessions', () => {
  beforeEach(() => {
    mockSecureStore.__store.clear();
    jest.clearAllMocks();
  });

  it('deletes every saved session, leaving loadSession returning null for each', async () => {
    const bobKeys = generateStaticKeys();
    const { state: aliceState } = initiateSession({
      contactUserId: 'alice',
      selfUserId: 'self-user-id',
      contactBundle: {
        x25519PublicKey: bobKeys.x25519.publicKey,
        kyberPublicKey: bobKeys.kyber.publicKey,
      },
    });
    const carolKeys = generateStaticKeys();
    const { state: carolState } = initiateSession({
      contactUserId: 'carol',
      selfUserId: 'self-user-id',
      contactBundle: {
        x25519PublicKey: carolKeys.x25519.publicKey,
        kyberPublicKey: carolKeys.kyber.publicKey,
      },
    });
    await saveSession('alice', aliceState);
    await saveSession('carol', carolState);

    await clearAllSessions();

    expect(await loadSession('alice')).toBeNull();
    expect(await loadSession('carol')).toBeNull();
  });

  it('is a no-op when no session has ever been saved', async () => {
    await expect(clearAllSessions()).resolves.toBeUndefined();
  });

  it('leaves the store fully empty afterward (no leftover index or session keys)', async () => {
    const bobKeys = generateStaticKeys();
    const { state } = initiateSession({
      contactUserId: 'alice',
      selfUserId: 'self-user-id',
      contactBundle: {
        x25519PublicKey: bobKeys.x25519.publicKey,
        kyberPublicKey: bobKeys.kyber.publicKey,
      },
    });
    await saveSession('alice', state);

    await clearAllSessions();

    expect(mockSecureStore.__store.size).toBe(0);
  });

  it('rejects and reconciles the index when one contact delete fails, leaving the other cleared', async () => {
    const bobKeys = generateStaticKeys();
    const { state: aliceState } = initiateSession({
      contactUserId: 'alice',
      selfUserId: 'self-user-id',
      contactBundle: {
        x25519PublicKey: bobKeys.x25519.publicKey,
        kyberPublicKey: bobKeys.kyber.publicKey,
      },
    });
    const carolKeys = generateStaticKeys();
    const { state: carolState } = initiateSession({
      contactUserId: 'carol',
      selfUserId: 'self-user-id',
      contactBundle: {
        x25519PublicKey: carolKeys.x25519.publicKey,
        kyberPublicKey: carolKeys.kyber.publicKey,
      },
    });
    await saveSession('alice', aliceState);
    await saveSession('carol', carolState);

    const carolSessionKey = 'epistl.ratchet_session.carol';
    const realDeleteItemAsync = mockSecureStore.deleteItemAsync.getMockImplementation()!;
    mockSecureStore.deleteItemAsync.mockImplementation(async (key: string) => {
      if (key === carolSessionKey) {
        throw new Error('simulated SecureStore failure');
      }
      return realDeleteItemAsync(key);
    });

    await expect(clearAllSessions()).rejects.toThrow(/carol/);

    expect(await loadSession('alice')).toBeNull();
    expect(await loadSession('carol')).toEqual(carolState);

    const rawIndex = mockSecureStore.__store.get('epistl.ratchet_session_index');
    expect(rawIndex).toBeDefined();
    expect(JSON.parse(rawIndex as string)).toEqual(['carol']);

    mockSecureStore.deleteItemAsync.mockImplementation(realDeleteItemAsync);

    await clearAllSessions();

    expect(mockSecureStore.__store.size).toBe(0);
  });
});
