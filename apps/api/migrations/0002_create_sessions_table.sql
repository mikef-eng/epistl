-- sessions table
--
-- Mirrors the upstream Better Auth "session" model (id, token, expiresAt,
-- userId, ipAddress, userAgent, timestamps), translated to Postgres
-- snake_case column names. See the note in 0001_create_users_table.sql
-- about better-auth-rs not yet shipping its own schema generator.
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
