CREATE TABLE `runners` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`name` text,
	`machine_fingerprint` text,
	`platform` text,
	`architecture` text,
	`token_hash` text NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `runners_user_deletion_index` ON `runners` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE UNIQUE INDEX `runners_active_machine_unique` ON `runners` (`machine_fingerprint`) WHERE "runners"."is_deleted" = false;--> statement-breakpoint
CREATE UNIQUE INDEX `runners_active_token_unique` ON `runners` (`token_hash`) WHERE "runners"."is_deleted" = false;