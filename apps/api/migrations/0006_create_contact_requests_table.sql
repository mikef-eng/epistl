-- contact_requests table
--
-- Owned outright by this app (not part of Better Auth). Stores only
-- relationship metadata for the pending-request/accept flow (see
-- docs/superpowers/specs/2026-09-13-mutual-contacts-design.md) -- never
-- message content or key material.
--
-- The existing `contacts` table (migrations/0003_create_contacts_table.sql)
-- is unchanged in shape; a row there only ever exists once a request here
-- has been accepted.
CREATE TABLE contact_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'declined'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ
);

-- Scoped to `WHERE status = 'pending'` so a declined request doesn't block
-- a fresh request later, per the design's data model.
CREATE UNIQUE INDEX contact_requests_pending_pair_idx
    ON contact_requests (requester_user_id, recipient_user_id)
    WHERE status = 'pending';

CREATE INDEX contact_requests_recipient_idx ON contact_requests (recipient_user_id);
