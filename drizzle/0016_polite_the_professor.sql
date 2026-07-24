CREATE TABLE `agent_pending_inputs` (
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
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `agent_pending_inputs_session_deletion_creation_index` ON `agent_pending_inputs` (`session_id`,`is_deleted`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_pending_inputs_user_request_unique` ON `agent_pending_inputs` (`user_id`,`client_request_id`);