PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`tournament_id` text NOT NULL,
	`name` text NOT NULL,
	`seed` integer,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "teams_status_check" CHECK(status IN ('forming', 'registered', 'checked_in', 'withdrawn', 'disbanded'))
);
--> statement-breakpoint
INSERT INTO `__new_teams`("id", "tournament_id", "name", "seed", "status", "created_at") SELECT "id", "tournament_id", "name", "seed", "status", "created_at" FROM `teams`;--> statement-breakpoint
DROP TABLE `teams`;--> statement-breakpoint
ALTER TABLE `__new_teams` RENAME TO `teams`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `teams_tournament_id_idx` ON `teams` (`tournament_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `teams_tournament_seed_unique` ON `teams` (`tournament_id`,`seed`);