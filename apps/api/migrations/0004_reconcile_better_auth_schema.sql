-- Reconcile the users/sessions schema (0001/0002) with the schema the real
-- `better-auth` crate (feature = "seaorm2") expects for its `AuthSession`,
-- `AuthAccount`, and `AuthVerification` entities.
--
-- Additive only -- 0001/0002/0003 are left untouched:
--   * sessions gains an `active` column. Better Auth's SeaORM session store
--     filters `WHERE active = true` on every session lookup (in addition to
--     the expiry check performed in-process), so the column must exist even
--     though this app never sets it to false itself yet (no sign-out/session
--     revocation endpoint -- that is separate follow-up work).
--   * `accounts` is a new table. Better Auth's email/password plugin stores
--     the credential (password hash) on an `accounts` row with
--     provider_id = 'credential', not directly on `users` -- the
--     `users.password_hash` column from 0001 is unused by this integration
--     and intentionally left in place rather than dropped.
--   * `verifications` is a new table required by the `AuthSchema` trait
--     (email verification / password reset tokens). No plugin in this app
--     currently issues verification tokens, but the table must exist for
--     the schema to type-check and for forward compatibility.
ALTER TABLE sessions ADD COLUMN active BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    access_token TEXT,
    refresh_token TEXT,
    id_token TEXT,
    access_token_expires_at TIMESTAMPTZ,
    refresh_token_expires_at TIMESTAMPTZ,
    scope TEXT,
    password TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX accounts_user_id_idx ON accounts (user_id);
CREATE UNIQUE INDEX accounts_provider_account_idx ON accounts (provider_id, account_id);

CREATE TABLE verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX verifications_identifier_idx ON verifications (identifier);
