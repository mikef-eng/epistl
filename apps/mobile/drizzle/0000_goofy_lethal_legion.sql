CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contact_user_id` text NOT NULL,
	`direction` text NOT NULL,
	`body_b64` text NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text
);
