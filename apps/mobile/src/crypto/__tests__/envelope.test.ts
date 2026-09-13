import 'react-native-get-random-values';

import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { concatBytes } from '@noble/hashes/utils.js';

import { bytesToUtf8, utf8ToBytes } from '../../utils/base64';
import {
  decodeHandshakeEnvelope,
  decodeRatchetEnvelope,
  encodeHandshakeEnvelope,
  encodeRatchetEnvelope,
  HANDSHAKE_ENVELOPE_VERSION,
  KYBER_CIPHERTEXT_LENGTH,
  ML_DSA65_SIGNATURE_LENGTH,
  RATCHET_ENVELOPE_VERSION,
  UINT32_FIELD_LENGTH,
  X25519_PUBLIC_KEY_LENGTH,
  XCHACHA20POLY1305_NONCE_LENGTH,
} from '../envelope';
import { deriveNextSendingMessageKey, initiateSession, receiveHandshake } from '../session';

function generateStaticKeys() {
  return { x25519: x25519.keygen(), kyber: ml_kem768.keygen() };
}

const aliceUserId = 'alice-user-id';
const bobUserId = 'bob-user-id';

function performHandshake() {
  const aliceDilithium = ml_dsa65.keygen();
  const bobDilithium = ml_dsa65.keygen();
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

  return { aliceState, aliceDilithium, bobDilithium, bobKeys, ea, kyberCiphertext };
}

describe('handshake envelope', () => {
  it('round trips: encode then decode recovers the original plaintext', () => {
    const { aliceState, aliceDilithium, bobKeys, ea, kyberCiphertext } = performHandshake();

    const send0 = deriveNextSendingMessageKey(aliceState);
    const plaintext = utf8ToBytes('hello bob, this is alice');

    const envelope = encodeHandshakeEnvelope({
      ea,
      kyberCiphertext,
      messageKey: send0.messageKey,
      plaintext,
      selfUserId: aliceUserId,
      contactUserId: bobUserId,
      signingSecretKey: aliceDilithium.secretKey,
    });

    expect(envelope[0]).toBe(HANDSHAKE_ENVELOPE_VERSION);

    const result = decodeHandshakeEnvelope(envelope, {
      contactUserId: aliceUserId,
      selfUserId: bobUserId,
      selfX25519SecretKey: bobKeys.x25519.secretKey,
      selfKyberSecretKey: bobKeys.kyber.secretKey,
      senderDilithiumPublicKey: aliceDilithium.publicKey,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(bytesToUtf8(result.plaintext)).toBe('hello bob, this is alice');
    // Bob's post-handshake state already ran the generic ratchet step, so
    // it has both chains established, matching session.test.ts's own
    // assertions about `receiveHandshake`'s output shape.
    expect(result.nextState.dhrPublicKey).toEqual(ea);
  });

  it('rejects a 0x01 (retired) version byte as unrecognized', () => {
    const { aliceState, aliceDilithium, bobKeys, ea, kyberCiphertext } = performHandshake();
    const send0 = deriveNextSendingMessageKey(aliceState);

    const envelope = encodeHandshakeEnvelope({
      ea,
      kyberCiphertext,
      messageKey: send0.messageKey,
      plaintext: utf8ToBytes('hi'),
      selfUserId: aliceUserId,
      contactUserId: bobUserId,
      signingSecretKey: aliceDilithium.secretKey,
    });
    const retired = Uint8Array.from(envelope);
    retired[0] = 0x01;

    const result = decodeHandshakeEnvelope(retired, {
      contactUserId: aliceUserId,
      selfUserId: bobUserId,
      selfX25519SecretKey: bobKeys.x25519.secretKey,
      selfKyberSecretKey: bobKeys.kyber.secretKey,
      senderDilithiumPublicKey: aliceDilithium.publicKey,
    });

    expect(result).toEqual({ ok: false, reason: 'unrecognized_version' });
  });

  it('a corrupted signature byte causes verification failure, not garbage plaintext', () => {
    const { aliceState, aliceDilithium, bobKeys, ea, kyberCiphertext } = performHandshake();
    const send0 = deriveNextSendingMessageKey(aliceState);

    const envelope = encodeHandshakeEnvelope({
      ea,
      kyberCiphertext,
      messageKey: send0.messageKey,
      plaintext: utf8ToBytes('hi'),
      selfUserId: aliceUserId,
      contactUserId: bobUserId,
      signingSecretKey: aliceDilithium.secretKey,
    });
    const tampered = Uint8Array.from(envelope);
    tampered[tampered.length - 1] ^= 0xff;

    const result = decodeHandshakeEnvelope(tampered, {
      contactUserId: aliceUserId,
      selfUserId: bobUserId,
      selfX25519SecretKey: bobKeys.x25519.secretKey,
      selfKyberSecretKey: bobKeys.kyber.secretKey,
      senderDilithiumPublicKey: aliceDilithium.publicKey,
    });

    expect(result).toEqual({ ok: false, reason: 'signature_failure' });
  });

  it('verifying with the wrong signer public key causes verification failure', () => {
    const { aliceState, aliceDilithium, bobKeys, ea, kyberCiphertext } = performHandshake();
    const send0 = deriveNextSendingMessageKey(aliceState);
    const wrongSigner = ml_dsa65.keygen();

    const envelope = encodeHandshakeEnvelope({
      ea,
      kyberCiphertext,
      messageKey: send0.messageKey,
      plaintext: utf8ToBytes('hi'),
      selfUserId: aliceUserId,
      contactUserId: bobUserId,
      signingSecretKey: aliceDilithium.secretKey,
    });

    const result = decodeHandshakeEnvelope(envelope, {
      contactUserId: aliceUserId,
      selfUserId: bobUserId,
      selfX25519SecretKey: bobKeys.x25519.secretKey,
      selfKyberSecretKey: bobKeys.kyber.secretKey,
      senderDilithiumPublicKey: wrongSigner.publicKey,
    });

    expect(result).toEqual({ ok: false, reason: 'signature_failure' });
  });

  it('a corrupted ciphertext byte (re-signed) causes an AEAD decryption failure, not garbage plaintext', () => {
    const { aliceState, aliceDilithium, bobKeys, ea, kyberCiphertext } = performHandshake();
    const send0 = deriveNextSendingMessageKey(aliceState);

    const envelope = encodeHandshakeEnvelope({
      ea,
      kyberCiphertext,
      messageKey: send0.messageKey,
      plaintext: utf8ToBytes('hi'),
      selfUserId: aliceUserId,
      contactUserId: bobUserId,
      signingSecretKey: aliceDilithium.secretKey,
    });

    // Corrupt one byte inside the AEAD ciphertext region, then re-sign with
    // the real sender key so signature verification still passes and the
    // module actually reaches the AEAD-decrypt step (in real life an
    // attacker without the secret key could never do this "re-sign" step —
    // this isolates the AEAD-failure code path from the signature-failure
    // one, as required by this test's own acceptance criterion).
    const ciphertextOffset =
      1 + X25519_PUBLIC_KEY_LENGTH + KYBER_CIPHERTEXT_LENGTH + UINT32_FIELD_LENGTH + XCHACHA20POLY1305_NONCE_LENGTH;
    const signedLength = envelope.length - ML_DSA65_SIGNATURE_LENGTH;
    const corruptedSigned = envelope.slice(0, signedLength);
    corruptedSigned[ciphertextOffset] ^= 0xff;
    const newSignature = ml_dsa65.sign(corruptedSigned, aliceDilithium.secretKey);
    const corrupted = concatBytes(corruptedSigned, newSignature);

    const result = decodeHandshakeEnvelope(corrupted, {
      contactUserId: aliceUserId,
      selfUserId: bobUserId,
      selfX25519SecretKey: bobKeys.x25519.secretKey,
      selfKyberSecretKey: bobKeys.kyber.secretKey,
      senderDilithiumPublicKey: aliceDilithium.publicKey,
    });

    expect(result).toEqual({ ok: false, reason: 'aead_failure' });
  });
});

describe('ratchet envelope', () => {
  function establishedStates() {
    const { aliceState, aliceDilithium, bobDilithium, bobKeys, ea, kyberCiphertext } =
      performHandshake();
    const { state: bobState } = receiveHandshake({
      contactUserId: aliceUserId,
      selfUserId: bobUserId,
      ea,
      kyberCiphertext,
      selfX25519SecretKey: bobKeys.x25519.secretKey,
      selfKyberSecretKey: bobKeys.kyber.secretKey,
    });
    return { aliceState, bobState, aliceDilithium, bobDilithium };
  }

  it('round trips: encode then decode recovers the original plaintext', () => {
    const { aliceState, bobState, bobDilithium } = establishedStates();

    const send = deriveNextSendingMessageKey(bobState);
    const plaintext = utf8ToBytes('hi alice, bob here');

    const envelope = encodeRatchetEnvelope({
      header: send.header,
      messageKey: send.messageKey,
      plaintext,
      selfUserId: bobUserId,
      contactUserId: aliceUserId,
      signingSecretKey: bobDilithium.secretKey,
    });

    expect(envelope[0]).toBe(RATCHET_ENVELOPE_VERSION);

    // This is Bob's first reply, which Alice's post-handshake state (she
    // hasn't received anything yet) decodes via the same "message 0 of an
    // already-established chain" path session.test.ts exercises directly.
    const result = decodeRatchetEnvelope(envelope, {
      state: aliceState,
      senderDilithiumPublicKey: bobDilithium.publicKey,
      selfUserId: aliceUserId,
      contactUserId: bobUserId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(bytesToUtf8(result.plaintext)).toBe('hi alice, bob here');
  });

  it('continues round-tripping across multiple messages with a real Alice/Bob exchange', () => {
    let { aliceState, bobState, aliceDilithium, bobDilithium } = establishedStates();

    function bobSendsAndAliceReceives(text: string) {
      const send = deriveNextSendingMessageKey(bobState);
      bobState = send.nextState;
      const envelope = encodeRatchetEnvelope({
        header: send.header,
        messageKey: send.messageKey,
        plaintext: utf8ToBytes(text),
        selfUserId: bobUserId,
        contactUserId: aliceUserId,
        signingSecretKey: bobDilithium.secretKey,
      });
      const result = decodeRatchetEnvelope(envelope, {
        state: aliceState,
        senderDilithiumPublicKey: bobDilithium.publicKey,
        selfUserId: aliceUserId,
        contactUserId: bobUserId,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok result');
      expect(bytesToUtf8(result.plaintext)).toBe(text);
      aliceState = result.nextState;
    }

    function aliceSendsAndBobReceives(text: string) {
      const send = deriveNextSendingMessageKey(aliceState);
      aliceState = send.nextState;
      const envelope = encodeRatchetEnvelope({
        header: send.header,
        messageKey: send.messageKey,
        plaintext: utf8ToBytes(text),
        selfUserId: aliceUserId,
        contactUserId: bobUserId,
        signingSecretKey: aliceDilithium.secretKey,
      });
      const result = decodeRatchetEnvelope(envelope, {
        state: bobState,
        senderDilithiumPublicKey: aliceDilithium.publicKey,
        selfUserId: bobUserId,
        contactUserId: aliceUserId,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok result');
      expect(bytesToUtf8(result.plaintext)).toBe(text);
      bobState = result.nextState;
    }

    bobSendsAndAliceReceives('hi alice');
    bobSendsAndAliceReceives('are you there?');
    aliceSendsAndBobReceives('yes, hi bob');
    bobSendsAndAliceReceives('great');
  });

  it('rejects an out-of-order message number without mutating state', () => {
    let { aliceState, bobState, bobDilithium } = establishedStates();

    // Bob sends message 0; Alice receives it normally first, so her
    // receiving chain is actually established (the very first message
    // after a handshake takes the unconditional "new chain" branch in
    // `deriveNextReceivingMessageKey`, which does not check message
    // numbers at all — see session.ts — so the out-of-order check this
    // test cares about only kicks in for a *later* message on an
    // already-established chain).
    const send0 = deriveNextSendingMessageKey(bobState);
    bobState = send0.nextState;
    const envelope0 = encodeRatchetEnvelope({
      header: send0.header,
      messageKey: send0.messageKey,
      plaintext: utf8ToBytes('message 0'),
      selfUserId: bobUserId,
      contactUserId: aliceUserId,
      signingSecretKey: bobDilithium.secretKey,
    });
    const result0 = decodeRatchetEnvelope(envelope0, {
      state: aliceState,
      senderDilithiumPublicKey: bobDilithium.publicKey,
      selfUserId: aliceUserId,
      contactUserId: bobUserId,
    });
    expect(result0.ok).toBe(true);
    if (!result0.ok) throw new Error('expected ok result');
    aliceState = result0.nextState;
    const aliceStateBeforeSkip = aliceState;

    // Bob sends message 1 (skipped/never delivered) then message 2; Alice
    // only ever sees message 2, which her state (still expecting message 1
    // on this same chain) must reject.
    const send1 = deriveNextSendingMessageKey(bobState);
    bobState = send1.nextState;
    const send2 = deriveNextSendingMessageKey(bobState);

    const envelope2 = encodeRatchetEnvelope({
      header: send2.header,
      messageKey: send2.messageKey,
      plaintext: utf8ToBytes('message 2, skipping message 1'),
      selfUserId: bobUserId,
      contactUserId: aliceUserId,
      signingSecretKey: bobDilithium.secretKey,
    });

    const result = decodeRatchetEnvelope(envelope2, {
      state: aliceState,
      senderDilithiumPublicKey: bobDilithium.publicKey,
      selfUserId: aliceUserId,
      contactUserId: bobUserId,
    });

    expect(result).toEqual({ ok: false, reason: 'rejected' });
    // `state` must be left byte-for-byte unchanged on rejection.
    expect(aliceState).toEqual(aliceStateBeforeSkip);
  });

  it('rejects a 0x01 (retired) version byte as unrecognized', () => {
    const { aliceState, bobState, bobDilithium } = establishedStates();
    const send = deriveNextSendingMessageKey(bobState);

    const envelope = encodeRatchetEnvelope({
      header: send.header,
      messageKey: send.messageKey,
      plaintext: utf8ToBytes('hi'),
      selfUserId: bobUserId,
      contactUserId: aliceUserId,
      signingSecretKey: bobDilithium.secretKey,
    });
    const retired = Uint8Array.from(envelope);
    retired[0] = 0x01;

    const result = decodeRatchetEnvelope(retired, {
      state: aliceState,
      senderDilithiumPublicKey: bobDilithium.publicKey,
      selfUserId: aliceUserId,
      contactUserId: bobUserId,
    });

    expect(result).toEqual({ ok: false, reason: 'unrecognized_version' });
  });

  it('a corrupted signature byte causes verification failure, not garbage plaintext', () => {
    const { aliceState, bobState, bobDilithium } = establishedStates();
    const send = deriveNextSendingMessageKey(bobState);

    const envelope = encodeRatchetEnvelope({
      header: send.header,
      messageKey: send.messageKey,
      plaintext: utf8ToBytes('hi'),
      selfUserId: bobUserId,
      contactUserId: aliceUserId,
      signingSecretKey: bobDilithium.secretKey,
    });
    const tampered = Uint8Array.from(envelope);
    tampered[tampered.length - 1] ^= 0xff;

    const result = decodeRatchetEnvelope(tampered, {
      state: aliceState,
      senderDilithiumPublicKey: bobDilithium.publicKey,
      selfUserId: aliceUserId,
      contactUserId: bobUserId,
    });

    expect(result).toEqual({ ok: false, reason: 'signature_failure' });
  });

  it('verifying with the wrong signer public key causes verification failure', () => {
    const { aliceState, bobState, bobDilithium } = establishedStates();
    const send = deriveNextSendingMessageKey(bobState);
    const wrongSigner = ml_dsa65.keygen();

    const envelope = encodeRatchetEnvelope({
      header: send.header,
      messageKey: send.messageKey,
      plaintext: utf8ToBytes('hi'),
      selfUserId: bobUserId,
      contactUserId: aliceUserId,
      signingSecretKey: bobDilithium.secretKey,
    });

    const result = decodeRatchetEnvelope(envelope, {
      state: aliceState,
      senderDilithiumPublicKey: wrongSigner.publicKey,
      selfUserId: aliceUserId,
      contactUserId: bobUserId,
    });

    expect(result).toEqual({ ok: false, reason: 'signature_failure' });
  });

  it('a corrupted ciphertext byte (re-signed) causes an AEAD decryption failure, not garbage plaintext', () => {
    const { aliceState, bobState, bobDilithium } = establishedStates();
    const send = deriveNextSendingMessageKey(bobState);

    const envelope = encodeRatchetEnvelope({
      header: send.header,
      messageKey: send.messageKey,
      plaintext: utf8ToBytes('hi'),
      selfUserId: bobUserId,
      contactUserId: aliceUserId,
      signingSecretKey: bobDilithium.secretKey,
    });

    const ciphertextOffset = 1 + X25519_PUBLIC_KEY_LENGTH + UINT32_FIELD_LENGTH * 2 + XCHACHA20POLY1305_NONCE_LENGTH;
    const signedLength = envelope.length - ML_DSA65_SIGNATURE_LENGTH;
    const corruptedSigned = envelope.slice(0, signedLength);
    corruptedSigned[ciphertextOffset] ^= 0xff;
    const newSignature = ml_dsa65.sign(corruptedSigned, bobDilithium.secretKey);
    const corrupted = concatBytes(corruptedSigned, newSignature);

    const result = decodeRatchetEnvelope(corrupted, {
      state: aliceState,
      senderDilithiumPublicKey: bobDilithium.publicKey,
      selfUserId: aliceUserId,
      contactUserId: bobUserId,
    });

    expect(result).toEqual({ ok: false, reason: 'aead_failure' });
  });
});
