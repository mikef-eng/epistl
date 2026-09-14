ALTER TABLE `messages` RENAME COLUMN "body_b64" TO "body";
--> statement-breakpoint
-- The messages_fts virtual table and its triggers (0001_messages_fts.sql)
-- reference messages.body_b64 by name, so they must be dropped and
-- recreated against the renamed `body` column — SQLite's `ALTER TABLE
-- RENAME COLUMN` does not follow references into other objects (e.g.
-- virtual tables, triggers).
DROP TRIGGER `messages_ai`;
--> statement-breakpoint
DROP TRIGGER `messages_ad`;
--> statement-breakpoint
DROP TRIGGER `messages_au`;
--> statement-breakpoint
DROP TABLE `messages_fts`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `messages_fts` USING fts5(
	`body`,
	content=`messages`,
	content_rowid=`id`
);
--> statement-breakpoint
-- Backfill: index any rows that existed before this migration ran (a no-op
-- on a fresh database with an empty `messages` table).
INSERT INTO `messages_fts`(`messages_fts`) VALUES('rebuild');
--> statement-breakpoint
CREATE TRIGGER `messages_ai` AFTER INSERT ON `messages` BEGIN
  INSERT INTO `messages_fts`(`rowid`, `body`) VALUES (new.id, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_ad` AFTER DELETE ON `messages` BEGIN
  INSERT INTO `messages_fts`(`messages_fts`, `rowid`, `body`) VALUES('delete', old.id, old.body);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_au` AFTER UPDATE ON `messages` BEGIN
  INSERT INTO `messages_fts`(`messages_fts`, `rowid`, `body`) VALUES('delete', old.id, old.body);
  INSERT INTO `messages_fts`(`rowid`, `body`) VALUES (new.id, new.body);
END;
