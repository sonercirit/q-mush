ALTER TABLE `openrouter_credentials` RENAME TO `provider_credentials`;--> statement-breakpoint
ALTER TABLE `provider_credentials` RENAME COLUMN "openrouter_user_id" TO "provider_account_id";--> statement-breakpoint
ALTER TABLE `provider_credentials` RENAME COLUMN "encrypted_api_key" TO "encrypted_credential";--> statement-breakpoint
ALTER TABLE `provider_credentials` RENAME COLUMN "api_key_fingerprint" TO "credential_fingerprint";--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_provider_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text,
	`label` text NOT NULL,
	`source` text NOT NULL,
	`encrypted_credential` text NOT NULL,
	`credential_fingerprint` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_provider_credentials`("id", "user_id", "created_at", "created_by_id", "updated_at", "updated_by_id", "is_deleted", "provider", "provider_account_id", "label", "source", "encrypted_credential", "credential_fingerprint") SELECT "id", "user_id", "created_at", "created_by_id", "updated_at", "updated_by_id", "is_deleted", 'openrouter', "provider_account_id", "label", "source", "encrypted_credential", "credential_fingerprint" FROM `provider_credentials`;--> statement-breakpoint
DROP TABLE `provider_credentials`;--> statement-breakpoint
ALTER TABLE `__new_provider_credentials` RENAME TO `provider_credentials`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `provider_credentials_user_provider_deletion_index` ON `provider_credentials` (`user_id`,`provider`,`is_deleted`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_credentials_user_provider_fingerprint_unique` ON `provider_credentials` (`user_id`,`provider`,`credential_fingerprint`);