PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_score_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`submitted_by_user_id` text NOT NULL,
	`submitted_for_team_id` text,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`superseded_by_id` text,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submitted_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submitted_for_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by_id`) REFERENCES `score_submissions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_score_submissions`("id", "match_id", "submitted_by_user_id", "submitted_for_team_id", "payload_json", "payload_hash", "created_at", "superseded_by_id") SELECT "id", "match_id", "submitted_by_user_id", "submitted_for_team_id", "payload_json", "payload_hash", "created_at", "superseded_by_id" FROM `score_submissions`;--> statement-breakpoint
DROP TABLE `score_submissions`;--> statement-breakpoint
ALTER TABLE `__new_score_submissions` RENAME TO `score_submissions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `score_submissions_match_id_idx` ON `score_submissions` (`match_id`);--> statement-breakpoint
CREATE INDEX `score_submissions_team_idx` ON `score_submissions` (`submitted_for_team_id`);--> statement-breakpoint
ALTER TABLE `tournaments` ADD `close_preview_json` text;