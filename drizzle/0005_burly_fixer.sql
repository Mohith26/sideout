ALTER TABLE `tournaments` ADD `lucra_matchup_verified_at` integer;--> statement-breakpoint
ALTER TABLE `tournaments` ADD `lucra_alert_json` text;--> statement-breakpoint
CREATE UNIQUE INDEX `lucra_links_lucra_user_id_unique` ON `lucra_links` (`lucra_user_id`);