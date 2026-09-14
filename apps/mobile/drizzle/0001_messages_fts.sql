-- Custom SQL migration file, put your code below! ----
-- FTS5 virtual table for full-text search over message content, kept in
-- sync with `messages` via an "external content" table (FTS5 stores only
-- the index, `messages.body_b64` remains the single source of truth) plus
-- INSERT/UPDATE/DELETE triggers, per the canonical SQLite recipe for
-- external-content FTS5 tables. `drizzle-orm`'s schema builder has no FTS5
-- support, so this is authored as a raw-SQL migration rather than
-- generated from `src/storage/schema.ts`.
CREATE VIRTUAL TABLE `messages_fts` USING fts5(
	`body_b64`,
	content=`messages`,
	content_rowid=`id`
);
--> statement-breakpoint
-- Backfill: index any rows that existed before this migration ran (a no-op
-- on a fresh database with an empty `messages` table).
INSERT INTO `messages_fts`(`messages_fts`) VALUES('rebuild');
--> statement-breakpoint
CREATE TRIGGER `messages_ai` AFTER INSERT ON `messages` BEGIN
  INSERT INTO `messages_fts`(`rowid`, `body_b64`) VALUES (new.id, new.body_b64);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_ad` AFTER DELETE ON `messages` BEGIN
  INSERT INTO `messages_fts`(`messages_fts`, `rowid`, `body_b64`) VALUES('delete', old.id, old.body_b64);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_au` AFTER UPDATE ON `messages` BEGIN
  INSERT INTO `messages_fts`(`messages_fts`, `rowid`, `body_b64`) VALUES('delete', old.id, old.body_b64);
  INSERT INTO `messages_fts`(`rowid`, `body_b64`) VALUES (new.id, new.body_b64);
END;
