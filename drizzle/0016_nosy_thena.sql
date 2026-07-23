CREATE TABLE `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`body` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `prompts_user_deletion_update_index` ON `prompts` (`user_id`,`is_deleted`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_user_normalized_name_active_unique` ON `prompts` (`user_id`,`normalized_name`) WHERE NOT "prompts"."is_deleted";