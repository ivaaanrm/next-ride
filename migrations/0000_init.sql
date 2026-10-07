CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_accounts_user_id` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hashed_key` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`last_used_at` text,
	`created_by_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hashed_key_unique` ON `api_keys` (`hashed_key`);--> statement-breakpoint
CREATE INDEX `ix_api_keys_prefix` ON `api_keys` (`prefix`);--> statement-breakpoint
CREATE TABLE `car_models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`make` text NOT NULL,
	`model` text NOT NULL,
	`trim` text DEFAULT '' NOT NULL,
	`make_model_key` text NOT NULL,
	`body_type` text,
	`reference_price` real,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `car_models_slug_unique` ON `car_models` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_car_model_identity` ON `car_models` (`make`,`model`,`trim`);--> statement-breakpoint
CREATE INDEX `ix_car_models_make_model_key` ON `car_models` (`make_model_key`);--> statement-breakpoint
CREATE TABLE `dealers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`website` text,
	`city` text,
	`country` text,
	`rating` real,
	`is_active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dealers_slug_unique` ON `dealers` (`slug`);--> statement-breakpoint
CREATE TABLE `offer_favorites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`offer_id` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_offer_favorite` ON `offer_favorites` (`user_id`,`offer_id`);--> statement-breakpoint
CREATE INDEX `ix_offer_favorites_offer` ON `offer_favorites` (`offer_id`);--> statement-breakpoint
CREATE TABLE `offer_price_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`offer_id` integer NOT NULL,
	`price` real NOT NULL,
	`recorded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_offer_price_history_offer` ON `offer_price_history` (`offer_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `offer_rankings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`offer_id` integer NOT NULL,
	`rank` integer NOT NULL,
	`score` integer NOT NULL,
	`verdict` text NOT NULL,
	`reasoning` text,
	`pros` text,
	`cons` text,
	FOREIGN KEY (`run_id`) REFERENCES `ranking_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_offer_rankings_verdict" CHECK(verdict IN ('excellent', 'good', 'fair', 'poor', 'avoid'))
);
--> statement-breakpoint
CREATE INDEX `ix_offer_rankings_run_rank` ON `offer_rankings` (`run_id`,`rank`);--> statement-breakpoint
CREATE INDEX `ix_offer_rankings_offer` ON `offer_rankings` (`offer_id`);--> statement-breakpoint
CREATE TABLE `offers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`external_id` text,
	`source` text,
	`dealer_id` integer NOT NULL,
	`car_model_id` integer NOT NULL,
	`title` text NOT NULL,
	`price` real NOT NULL,
	`original_price` real,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`year` integer,
	`mileage_km` integer,
	`power_hp` integer,
	`condition` text DEFAULT 'used' NOT NULL,
	`fuel_type` text,
	`transmission` text,
	`location` text,
	`image_url` text,
	`status` text DEFAULT 'active' NOT NULL,
	`dismissed_at` text,
	`dismissed_by_id` text,
	`dismiss_reason` text,
	`first_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`manual_fields` text DEFAULT '[]' NOT NULL,
	`edited_at` text,
	`edited_by_id` text,
	`equipment_rating` integer,
	`apparent_condition_rating` integer,
	`raw_ref` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`dealer_id`) REFERENCES `dealers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`car_model_id`) REFERENCES `car_models`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`dismissed_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`edited_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_offers_status" CHECK(status IN ('active', 'dismissed', 'expired')),
	CONSTRAINT "ck_offers_condition" CHECK(condition IN ('new', 'km0', 'used', 'demo')),
	CONSTRAINT "ck_offers_fuel_type" CHECK(fuel_type IS NULL OR fuel_type IN ('petrol', 'diesel', 'hybrid', 'plugin_hybrid', 'electric', 'lpg', 'other')),
	CONSTRAINT "ck_offers_transmission" CHECK(transmission IS NULL OR transmission IN ('manual', 'automatic', 'other')),
	CONSTRAINT "ck_offers_ratings" CHECK((equipment_rating IS NULL OR equipment_rating BETWEEN 1 AND 5) AND (apparent_condition_rating IS NULL OR apparent_condition_rating BETWEEN 1 AND 5))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offers_url_unique` ON `offers` (`url`);--> statement-breakpoint
CREATE INDEX `ix_offers_model_status_price` ON `offers` (`car_model_id`,`status`,`price`);--> statement-breakpoint
CREATE INDEX `ix_offers_dealer_status` ON `offers` (`dealer_id`,`status`);--> statement-breakpoint
CREATE INDEX `ix_offers_status_last_seen` ON `offers` (`status`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `ix_offers_external_id` ON `offers` (`external_id`);--> statement-breakpoint
CREATE TABLE `ranking_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`make_model_key` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`triggered_by_id` text,
	`model_used` text,
	`effort` text,
	`offers_considered` integer DEFAULT 0 NOT NULL,
	`iterations` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`summary` text,
	`error` text,
	`tool_trace` text,
	`request` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`triggered_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_ranking_runs_status" CHECK(status IN ('pending', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `ix_ranking_runs_binomio_created` ON `ranking_runs` (`make_model_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `score_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`weights` text NOT NULL,
	`params` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scrape_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`search_url_template` text,
	`listing_url` text,
	`access` text NOT NULL,
	`notes` text,
	`config` text DEFAULT '{}' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "ck_scrape_sources_access" CHECK(access IN ('fetch', 'playwright', 'browser', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scrape_sources_key_unique` ON `scrape_sources` (`key`);--> statement-breakpoint
CREATE TABLE `scrape_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`make_model_key` text NOT NULL,
	`make` text NOT NULL,
	`model` text NOT NULL,
	`max_results` integer DEFAULT 15 NOT NULL,
	`search_url` text,
	`search_params` text DEFAULT '{}' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `scrape_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_scrape_target_source_model` ON `scrape_targets` (`source_id`,`make_model_key`);--> statement-breakpoint
CREATE INDEX `ix_scrape_targets_active` ON `scrape_targets` (`is_active`,`source_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `ix_sessions_user_id` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `tracked_models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`car_model_id` integer NOT NULL,
	`target_price` real,
	`max_mileage_km` integer,
	`min_year` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`car_model_id`) REFERENCES `car_models`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tracked_model` ON `tracked_models` (`user_id`,`car_model_id`);--> statement-breakpoint
CREATE INDEX `ix_tracked_models_car_model_id` ON `tracked_models` (`car_model_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`is_superuser` integer DEFAULT false NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_verifications_identifier` ON `verifications` (`identifier`);