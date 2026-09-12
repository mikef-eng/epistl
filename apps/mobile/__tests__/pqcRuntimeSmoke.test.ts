/**
 * Runtime smoke test for the pinned PQC libraries.
 *
 * This exists to answer a specific open risk flagged in issue #36: the
 * `@noble/post-quantum` / `@noble/curves` npm metadata and source were
 * verified during planning, but the library had never actually been
 * executed inside a Jest run using the `jest-expo` preset (which emulates
 * the Hermes/React Native runtime environment). This test must keep
 * actually calling keygen/sign/verify/encapsulate — not just type-check —
 * so a future Hermes-incompatibility regression would fail CI here first.
 */
import 'react-native-get-random-values';

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { x25519 } from '@noble/curves/ed25519.js';

describe('PQC runtime smoke test (jest-expo / Hermes environment)', () => {
  it('ml_kem768 can generate a keypair and encapsulate/decapsulate a shared secret', () => {
    const { publicKey, secretKey } = ml_kem768.keygen();
    expect(publicKey.length).toBe(1184);
    expect(secretKey.length).toBe(2400);

    const { cipherText, sharedSecret } = ml_kem768.encapsulate(publicKey);
    const decapsulated = ml_kem768.decapsulate(cipherText, secretKey);
    expect(decapsulated).toEqual(sharedSecret);
  });

  it('ml_dsa65 can generate a keypair and sign/verify a message', () => {
    const { publicKey, secretKey } = ml_dsa65.keygen();
    expect(publicKey.length).toBe(1952);
    expect(secretKey.length).toBe(4032);

    const message = new TextEncoder().encode('epistl runtime smoke test');
    const signature = ml_dsa65.sign(message, secretKey);
    expect(signature.length).toBe(3309);
    expect(ml_dsa65.verify(signature, message, publicKey)).toBe(true);
  });

  it('x25519 can generate a keypair and derive a matching shared secret', () => {
    const alice = x25519.keygen();
    const bob = x25519.keygen();
    expect(alice.publicKey.length).toBe(32);
    expect(alice.secretKey.length).toBe(32);

    const aliceShared = x25519.getSharedSecret(alice.secretKey, bob.publicKey);
    const bobShared = x25519.getSharedSecret(bob.secretKey, alice.publicKey);
    expect(aliceShared).toEqual(bobShared);
  });
});
