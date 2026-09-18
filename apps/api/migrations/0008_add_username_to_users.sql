-- Add a unique, required `username` column to `users`.
--
-- The current dev database already has real user rows (created before this
-- migration existed) with no username, so this can't just add a `NOT NULL`
-- column outright -- it has to backfill first. All three steps run in this
-- one migration file, in order:
--
--   1. Add the column nullable.
--   2. Backfill any existing NULL `username` to a guaranteed-unique,
--      non-identity-revealing placeholder derived from the row's own `id`
--      (never a value derived from or referencing a specific named user).
--      A real human should replace these by hand later via the
--      settings-panel change-username endpoint (a separate, later issue) --
--      this migration intentionally does not hardcode or special-case any
--      specific row.
--   3. Tighten the column to `NOT NULL` and add a `UNIQUE` constraint,
--      mirroring the existing `email TEXT UNIQUE NOT NULL` precedent from
--      0001_create_users_table.sql.
ALTER TABLE users ADD COLUMN username TEXT;

UPDATE users SET username = id::text WHERE username IS NULL;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
