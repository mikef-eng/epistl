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
