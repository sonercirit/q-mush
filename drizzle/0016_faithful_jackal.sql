CREATE TABLE `provider_limit_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`credential_id` text NOT NULL,
	`dimensions` text NOT NULL,
	`observed_at` integer NOT NULL,
	`provider` text NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`credential_id`) REFERENCES `provider_credentials`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_limit_observations_credential_unique` ON `provider_limit_observations` (`credential_id`);--> statement-breakpoint
CREATE INDEX `provider_limit_observations_user_deletion_index` ON `provider_limit_observations` (`is_deleted`,`user_id`);
