CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`actor_kind` text NOT NULL,
	`action` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`detail_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "audit_log_actor_kind_check" CHECK(actor_kind IN ('player', 'organizer', 'system', 'lucra_webhook'))
);
--> statement-breakpoint
CREATE INDEX `audit_log_subject_idx` ON `audit_log` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `audit_log_created_at_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `charities` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ein` text,
	`mission_short` text NOT NULL,
	`logo_url` text,
	`website_url` text
);
--> statement-breakpoint
CREATE TABLE `donations` (
	`id` text PRIMARY KEY NOT NULL,
	`tournament_id` text NOT NULL,
	`team_id` text,
	`user_id` text,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`provider` text NOT NULL,
	`provider_ref` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "donations_provider_check" CHECK(provider IN ('stub', 'stripe')),
	CONSTRAINT "donations_status_check" CHECK(status IN ('pending', 'succeeded', 'refunded', 'failed')),
	CONSTRAINT "donations_amount_positive" CHECK(amount_cents > 0)
);
--> statement-breakpoint
CREATE INDEX `donations_tournament_id_idx` ON `donations` (`tournament_id`);--> statement-breakpoint
CREATE INDEX `donations_status_idx` ON `donations` (`status`);--> statement-breakpoint
CREATE TABLE `lucra_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`lucra_user_id` text,
	`external_id` text NOT NULL,
	`verification_state` text NOT NULL,
	`linked_at` integer,
	`last_synced_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lucra_links_verification_state_check" CHECK(verification_state IN ('unverified', 'verified', 'not_allowed', 'demographics_missing'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lucra_links_external_id_unique` ON `lucra_links` (`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lucra_links_user_id_unique` ON `lucra_links` (`user_id`);--> statement-breakpoint
CREATE TABLE `lucra_score_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`tournament_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_json` text NOT NULL,
	`response_json` text,
	`http_status` integer,
	`affected_matchup_ids_json` text NOT NULL,
	`failed_matchup_ids_json` text NOT NULL,
	`outcome` text NOT NULL,
	`attempt` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lucra_score_submissions_outcome_check" CHECK(outcome IN ('pending', 'accepted', 'partial', 'rejected', 'transport_error')),
	CONSTRAINT "lucra_score_submissions_attempt_positive" CHECK(attempt >= 1)
);
--> statement-breakpoint
CREATE INDEX `lucra_score_submissions_match_id_idx` ON `lucra_score_submissions` (`match_id`);--> statement-breakpoint
CREATE INDEX `lucra_score_submissions_tournament_id_idx` ON `lucra_score_submissions` (`tournament_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lucra_score_submissions_key_attempt_unique` ON `lucra_score_submissions` (`idempotency_key`,`attempt`);--> statement-breakpoint
CREATE TABLE `match_consensus` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`state` text NOT NULL,
	`agreed_payload_json` text,
	`agreed_payload_hash` text,
	`disputed_reason` text,
	`resolved_by_user_id` text,
	`idempotency_key` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "match_consensus_state_check" CHECK(state IN ('awaiting_first', 'awaiting_second', 'agreed', 'disputed', 'submitting', 'accepted', 'partial', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_consensus_match_id_unique` ON `match_consensus` (`match_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `match_consensus_idempotency_key_unique` ON `match_consensus` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `match_consensus_state_idx` ON `match_consensus` (`state`);--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`tournament_id` text NOT NULL,
	`pool_id` text,
	`round` integer NOT NULL,
	`bracket_position` integer,
	`court_label` text,
	`team_a_id` text,
	`team_b_id` text,
	`best_of` text NOT NULL,
	`status` text NOT NULL,
	`winner_team_id` text,
	`next_match_id` text,
	`next_match_slot` text,
	`scheduled_at` integer,
	`started_at` integer,
	`finalized_at` integer,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pool_id`) REFERENCES `pools`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_a_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_b_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`winner_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`next_match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "matches_best_of_check" CHECK(best_of IN ('1', '3')),
	CONSTRAINT "matches_status_check" CHECK(status IN ('scheduled', 'in_progress', 'awaiting_scores', 'disputed', 'final', 'forfeited', 'bye')),
	CONSTRAINT "matches_next_match_slot_check" CHECK(next_match_slot IS NULL OR next_match_slot IN ('a', 'b')),
	CONSTRAINT "matches_bye_shape" CHECK(status <> 'bye' OR team_b_id IS NULL),
	CONSTRAINT "matches_distinct_teams" CHECK(team_a_id IS NULL OR team_b_id IS NULL OR team_a_id <> team_b_id)
);
--> statement-breakpoint
CREATE INDEX `matches_tournament_id_idx` ON `matches` (`tournament_id`);--> statement-breakpoint
CREATE INDEX `matches_pool_id_idx` ON `matches` (`pool_id`);--> statement-breakpoint
CREATE INDEX `matches_status_idx` ON `matches` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `matches_bracket_position_unique` ON `matches` (`tournament_id`,`bracket_position`);--> statement-breakpoint
CREATE TABLE `pool_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`pool_id` text NOT NULL,
	`team_id` text NOT NULL,
	FOREIGN KEY (`pool_id`) REFERENCES `pools`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pool_teams_pool_team_unique` ON `pool_teams` (`pool_id`,`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pool_teams_team_unique` ON `pool_teams` (`team_id`);--> statement-breakpoint
CREATE TABLE `pools` (
	`id` text PRIMARY KEY NOT NULL,
	`tournament_id` text NOT NULL,
	`label` text NOT NULL,
	`court_label` text NOT NULL,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pools_tournament_id_idx` ON `pools` (`tournament_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pools_tournament_label_unique` ON `pools` (`tournament_id`,`label`);--> statement-breakpoint
CREATE TABLE `rewards` (
	`id` text PRIMARY KEY NOT NULL,
	`tournament_id` text NOT NULL,
	`team_id` text NOT NULL,
	`placement` integer NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer,
	`currency` text,
	`description` text NOT NULL,
	`lucra_reward_ref` text,
	`status` text NOT NULL,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "rewards_kind_check" CHECK(kind IN ('lucra_reward', 'sponsor_item', 'credit')),
	CONSTRAINT "rewards_status_check" CHECK(status IN ('projected', 'awarded', 'claimed')),
	CONSTRAINT "rewards_placement_positive" CHECK(placement >= 1),
	CONSTRAINT "rewards_amount_has_currency" CHECK(amount_cents IS NULL OR currency IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `rewards_tournament_id_idx` ON `rewards` (`tournament_id`);--> statement-breakpoint
CREATE INDEX `rewards_team_id_idx` ON `rewards` (`team_id`);--> statement-breakpoint
CREATE TABLE `score_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`submitted_by_user_id` text NOT NULL,
	`submitted_for_team_id` text NOT NULL,
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
CREATE INDEX `score_submissions_match_id_idx` ON `score_submissions` (`match_id`);--> statement-breakpoint
CREATE INDEX `score_submissions_team_idx` ON `score_submissions` (`submitted_for_team_id`);--> statement-breakpoint
CREATE TABLE `sets` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`set_number` integer NOT NULL,
	`team_a_points` integer NOT NULL,
	`team_b_points` integer NOT NULL,
	`agreed` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sets_set_number_range" CHECK(set_number BETWEEN 1 AND 3),
	CONSTRAINT "sets_points_nonneg" CHECK(team_a_points >= 0 AND team_b_points >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sets_match_set_number_unique` ON `sets` (`match_id`,`set_number`);--> statement-breakpoint
CREATE TABLE `sponsors` (
	`id` text PRIMARY KEY NOT NULL,
	`tournament_id` text NOT NULL,
	`name` text NOT NULL,
	`logo_url` text,
	`tier` text NOT NULL,
	`prize_contribution_cents` integer NOT NULL,
	`currency` text NOT NULL,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sponsors_tier_check" CHECK(tier IN ('presenting', 'court', 'prize')),
	CONSTRAINT "sponsors_contribution_nonneg" CHECK(prize_contribution_cents >= 0)
);
--> statement-breakpoint
CREATE INDEX `sponsors_tournament_id_idx` ON `sponsors` (`tournament_id`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "team_members_role_check" CHECK(role IN ('captain', 'player'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_members_team_user_unique` ON `team_members` (`team_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `team_members_user_id_idx` ON `team_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`tournament_id` text NOT NULL,
	`name` text NOT NULL,
	`seed` integer,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "teams_status_check" CHECK(status IN ('registered', 'checked_in', 'withdrawn'))
);
--> statement-breakpoint
CREATE INDEX `teams_tournament_id_idx` ON `teams` (`tournament_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `teams_tournament_seed_unique` ON `teams` (`tournament_id`,`seed`);--> statement-breakpoint
CREATE TABLE `tournaments` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`subtitle` text,
	`beneficiary_id` text NOT NULL,
	`venue_name` text NOT NULL,
	`venue_city` text NOT NULL,
	`venue_state` text NOT NULL,
	`venue_timezone` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`format` text NOT NULL,
	`division` text NOT NULL,
	`max_teams` integer NOT NULL,
	`entry_donation_cents` integer NOT NULL,
	`fundraising_goal_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`prize_kind` text NOT NULL,
	`status` text NOT NULL,
	`lucra_matchup_id` text,
	`lucra_external_id` text NOT NULL,
	`lucra_game_id` text NOT NULL,
	`lucra_location_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`beneficiary_id`) REFERENCES `charities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tournaments_format_check" CHECK(format IN ('pool_to_bracket', 'single_elim', 'double_elim', 'round_robin')),
	CONSTRAINT "tournaments_division_check" CHECK(division IN ('open', 'womens', 'mens', 'coed', 'rec')),
	CONSTRAINT "tournaments_prize_kind_check" CHECK(prize_kind IN ('free_to_play_rewards', 'real_money')),
	CONSTRAINT "tournaments_status_check" CHECK(status IN ('draft', 'registration_open', 'registration_closed', 'live', 'awaiting_settlement', 'settled', 'cancelled')),
	CONSTRAINT "tournaments_max_teams_positive" CHECK(max_teams > 0),
	CONSTRAINT "tournaments_entry_donation_nonneg" CHECK(entry_donation_cents >= 0),
	CONSTRAINT "tournaments_goal_nonneg" CHECK(fundraising_goal_cents >= 0),
	CONSTRAINT "tournaments_ends_after_start" CHECK(ends_at >= starts_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tournaments_slug_unique` ON `tournaments` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `tournaments_lucra_external_id_unique` ON `tournaments` (`lucra_external_id`);--> statement-breakpoint
CREATE INDEX `tournaments_status_idx` ON `tournaments` (`status`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`phone_e164` text,
	`email` text,
	`avatar_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_phone_e164_unique` ON `users` (`phone_e164`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`event_type` text NOT NULL,
	`external_event_id` text NOT NULL,
	`signature_valid` integer NOT NULL,
	`raw_body` text NOT NULL,
	`parsed_json` text,
	`processing_state` text NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	CONSTRAINT "webhook_events_provider_check" CHECK(provider IN ('lucra')),
	CONSTRAINT "webhook_events_processing_state_check" CHECK(processing_state IN ('received', 'processed', 'ignored', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_events_external_event_id_unique` ON `webhook_events` (`external_event_id`);--> statement-breakpoint
CREATE INDEX `webhook_events_processing_state_idx` ON `webhook_events` (`processing_state`);