CREATE TABLE `attachment_fallbacks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`modality` text NOT NULL,
	`provider_credential_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`provider_credential_id`) REFERENCES `provider_credentials`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `attachment_fallbacks_user_deletion_index` ON `attachment_fallbacks` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_fallbacks_user_modality_active_unique` ON `attachment_fallbacks` (`user_id`,`modality`) WHERE NOT "attachment_fallbacks"."is_deleted";--> statement-breakpoint
CREATE TABLE `provider_quota_reset_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`provider_credential_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`outcome` text,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`provider_credential_id`) REFERENCES `provider_credentials`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `provider_quota_reset_receipts_user_deletion_index` ON `provider_quota_reset_receipts` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_quota_reset_receipts_active_request_unique` ON `provider_quota_reset_receipts` (`user_id`,`provider_credential_id`,`client_request_id`) WHERE NOT "provider_quota_reset_receipts"."is_deleted";--> statement-breakpoint
CREATE UNIQUE INDEX `provider_quota_reset_receipts_pending_credential_unique` ON `provider_quota_reset_receipts` (`provider_credential_id`) WHERE NOT "provider_quota_reset_receipts"."is_deleted" AND "provider_quota_reset_receipts"."outcome" IS NULL;--> statement-breakpoint
CREATE TABLE `provider_quota_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`provider_credential_id` text NOT NULL,
	`auto_reset_threshold_percent` real DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`provider_credential_id`) REFERENCES `provider_credentials`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "provider_quota_settings_threshold_range_check" CHECK("provider_quota_settings"."auto_reset_threshold_percent" >= 0 AND "provider_quota_settings"."auto_reset_threshold_percent" <= 100)
);
--> statement-breakpoint
CREATE INDEX `provider_quota_settings_user_deletion_index` ON `provider_quota_settings` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_quota_settings_active_credential_unique` ON `provider_quota_settings` (`provider_credential_id`) WHERE NOT "provider_quota_settings"."is_deleted";