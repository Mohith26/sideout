CREATE TABLE `auth_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`phone_e164` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_codes_phone_idx` ON `auth_codes` (`phone_e164`,`created_at`);--> statement-breakpoint
CREATE TABLE `team_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`phone_e164` text NOT NULL,
	`status` text NOT NULL,
	`accepted_by_user_id` text,
	`created_at` integer NOT NULL,
	`responded_at` integer,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accepted_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "team_invites_status_check" CHECK(status IN ('pending', 'accepted', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX `team_invites_team_id_idx` ON `team_invites` (`team_id`);--> statement-breakpoint
CREATE INDEX `team_invites_phone_idx` ON `team_invites` (`phone_e164`,`status`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`tournament_id` text NOT NULL,
	`name` text NOT NULL,
	`seed` integer,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "teams_status_check" CHECK(status IN ('forming', 'registered', 'checked_in', 'withdrawn'))
);
--> statement-breakpoint
INSERT INTO `__new_teams`("id", "tournament_id", "name", "seed", "status", "created_at") SELECT "id", "tournament_id", "name", "seed", "status", "created_at" FROM `teams`;--> statement-breakpoint
DROP TABLE `teams`;--> statement-breakpoint
ALTER TABLE `__new_teams` RENAME TO `teams`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `teams_tournament_id_idx` ON `teams` (`tournament_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `teams_tournament_seed_unique` ON `teams` (`tournament_id`,`seed`);--> statement-breakpoint
-- Hand-edited: drizzle-kit emitted a table rebuild that SELECTs the new `role`
-- column from the old table. SQLite supports adding a NOT NULL column with a
-- default and a CHECK in place, which also keeps the phase-1 rows and indexes.
ALTER TABLE `users` ADD COLUMN `role` text DEFAULT 'player' NOT NULL CONSTRAINT "users_role_check" CHECK(role IN ('player', 'organizer'));
