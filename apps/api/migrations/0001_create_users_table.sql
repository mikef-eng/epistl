-- users table
--
-- Better Auth RS (https://crates.io/crates/better-auth-rs) is, as of the
-- version pinned in this crate's Cargo.toml, an early-stage crate that does
-- not yet ship its own migration/schema generator. Until it does, this table
-- is hand-written to match the field set documented by the upstream Better
-- Auth project's "user" model (id, email, emailVerified, name, image,
-- timestamps), translated to Postgres snake_case column names, plus a
-- password_hash column for credential (email/password) storage.
--
-- This table intentionally stores no message content and no PQC key
-- material (see AGENTS.md / README architecture constraints).
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    email_verified BOOLEAN NOT NULL DEFAULT false,
    name TEXT,
    image TEXT,
    password_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
