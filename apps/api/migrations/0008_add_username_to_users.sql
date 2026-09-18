-- Add a unique, required `username` column to `users`, mirroring the
-- existing `email TEXT UNIQUE NOT NULL` precedent from
-- 0001_create_users_table.sql.
--
-- Collected at signup going forward via `better-auth`'s own built-in
-- username support (the `EmailPasswordPlugin` this app already enables
-- natively accepts a `username` field in its `/sign-up/email` payload and
-- creates the user atomically with it -- see `apps/api/src/auth.rs`). This
-- migration only adds the column/constraint; it does not touch any
-- application logic.
--
-- The dev database currently has 2 existing real user rows with no
-- username. Backfilling them to a value derived from their own `id` keeps
-- the `NOT NULL`/`UNIQUE` constraints satisfiable without inventing or
-- referencing any specific named user. A human should replace these
-- placeholder usernames out-of-band after this migration lands (see issue
-- #183's "out of scope").
ALTER TABLE users ADD COLUMN username TEXT;

UPDATE users SET username = id::text WHERE username IS NULL;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);

-- Better Auth's own `CreateUser`/`UpdateUser` types also carry a
-- `display_username` (nullable, no uniqueness requirement -- it's a
-- display-only mirror of `username`, defaulted by Better Auth itself to
-- match `username` when the caller doesn't send a distinct one). This app
-- doesn't collect a separate display name yet (see issue #183's "out of
-- scope"), but the column must exist for that value to round-trip through
-- this app's schema instead of being silently dropped.
ALTER TABLE users ADD COLUMN display_username TEXT;
