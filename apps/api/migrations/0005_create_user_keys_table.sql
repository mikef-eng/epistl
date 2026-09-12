-- user_keys table
--
-- Public key material for the PQXDH-style handshake
-- (docs/decisions/0005-pqxdh-handshake-classical-ratchet.md). Storing public
-- keys here is explicitly allowed by
-- docs/decisions/0004-public-keys-allowed-in-postgres.md -- these are never
-- private key material and never message content.
--
-- One row per user: no multi-device, no key history/versioning, no separate
-- rotating signed-prekey distinct from the identity key (issue #35).
CREATE TABLE user_keys (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- 32 bytes, X25519 (RFC 7748) -- classical DH half of the handshake.
    x25519_public_key BYTEA NOT NULL,
    -- 1184 bytes, ML-KEM-768 (FIPS 203) public key -- the handshake's KEM prekey.
    kyber_public_key BYTEA NOT NULL,
    -- 1952 bytes, ML-DSA-65 (FIPS 204) identity/signing public key.
    dilithium_public_key BYTEA NOT NULL,
    -- 3309 bytes, ML-DSA-65 (FIPS 204) signature over
    -- x25519_public_key || kyber_public_key. Stored and relayed as an
    -- opaque blob -- the API never inspects its contents beyond length; see
    -- issue #35's Notes and issue #38 for verification (client-side).
    prekey_signature BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
