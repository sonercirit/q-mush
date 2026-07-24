PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_pending_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`session_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`images` text,
	`sequence` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_agent_pending_inputs` (
	`id`,
	`user_id`,
	`created_at`,
	`created_by_id`,
	`updated_at`,
	`updated_by_id`,
	`is_deleted`,
	`session_id`,
	`client_request_id`,
	`kind`,
	`content`,
	`images`,
	`sequence`
)
SELECT
	`id`,
	`user_id`,
	`created_at`,
	`created_by_id`,
	`updated_at`,
	`updated_by_id`,
	`is_deleted`,
	`session_id`,
	`client_request_id`,
	`kind`,
	`content`,
	`images`,
	ROW_NUMBER() OVER (
		PARTITION BY `session_id`
		ORDER BY `created_at`, `id`
	)
FROM `agent_pending_inputs`;--> statement-breakpoint
DROP TABLE `agent_pending_inputs`;--> statement-breakpoint
ALTER TABLE `__new_agent_pending_inputs` RENAME TO `agent_pending_inputs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agent_pending_inputs_session_deletion_sequence_index` ON `agent_pending_inputs` (`session_id`,`is_deleted`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_pending_inputs_session_sequence_unique` ON `agent_pending_inputs` (`session_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_pending_inputs_user_request_unique` ON `agent_pending_inputs` (`user_id`,`client_request_id`);
