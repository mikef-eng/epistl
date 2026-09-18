/**
 * Drizzle schema for the on-device message history database, per
 * docs/decisions/0012-mobile-local-storage-uses-drizzle-going-forward.md.
 * Schema changes are made here and then turned into a real migration via
 * `npm run db:generate` (see apps/mobile/drizzle.config.ts and the
 * generated `apps/mobile/drizzle/` folder) rather than hand-written
 * `ALTER TABLE`/`PRAGMA` guards.
 */
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  contactUserId: text('contact_user_id').notNull(),
  direction: text('direction').notNull().$type<'outgoing' | 'incoming'>(),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull(),
  // Nullable: unset for outgoing messages and for incoming messages that
  // haven't been read yet.
  readAt: text('read_at'),
});

/**
 * Caches each contact's `username` locally (issue #174), so a message
 * sender's display name is available for an offline push notification
 * without a network round-trip. `userId` is unique -- one row per contact,
 * upserted whenever a `GET /api/contacts` fetch succeeds (see
 * `storage/contacts.ts::upsertContacts`). Deliberately narrow: `username`
 * only, not a general-purpose contact directory (see that issue's "Out of
 * scope").
 */
export const contacts = sqliteTable('contacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull().unique(),
  username: text('username').notNull(),
});
