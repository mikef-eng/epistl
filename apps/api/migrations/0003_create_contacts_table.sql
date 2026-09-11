-- contacts table
--
-- Owned outright by this app (not part of Better Auth). Stores only the
-- relationship between two users -- never message content or key material.
CREATE TABLE contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_user_id, contact_user_id)
);

CREATE INDEX contacts_owner_user_id_idx ON contacts (owner_user_id);
