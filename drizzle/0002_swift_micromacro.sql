CREATE TABLE `openrouter_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`openrouter_user_id` text,
	`label` text NOT NULL,
	`source` text NOT NULL,
	`encrypted_api_key` text NOT NULL,
	`api_key_fingerprint` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `openrouter_credentials_user_deletion_index` ON `openrouter_credentials` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE UNIQUE INDEX `openrouter_credentials_user_fingerprint_unique` ON `openrouter_credentials` (`user_id`,`api_key_fingerprint`);