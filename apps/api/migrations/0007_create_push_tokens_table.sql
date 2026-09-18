-- push_tokens table
--
-- Server-side storage for per-device push notification tokens (e.g. Expo
-- push tokens), registered via `POST /api/push-tokens` (issue #166). This
-- is device-wake-up-ping metadata, not message content, so it does not
-- conflict with docs/decisions/0001-message-content-never-in-postgres.md --
-- compare to docs/decisions/0004-public-keys-allowed-in-postgres.md's
-- precedent for what kind of non-content metadata is fine in Postgres.
--
-- `token` is globally unique (not unique per-user): a device can only ever
-- be registered to one user's `user_id` at a time, so re-registering a
-- token that was previously associated with a different user (e.g. a
-- shared/reused device re-logging in as a different account) reassigns the
-- existing row rather than erroring or creating a duplicate.
--
-- A sibling issue ("API: trigger push notification when a message is
-- queued for offline delivery") reads from this table; there's no
-- DELETE/un-registration endpoint yet (out of scope for issue #166) -- a
-- stale token is simply left in place for now.
CREATE TABLE push_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX push_tokens_user_id_idx ON push_tokens (user_id);
