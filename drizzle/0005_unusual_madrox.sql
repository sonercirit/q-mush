CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_call_id` text,
	`tool_name` text,
	`tool_calls` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `agent_messages_session_deletion_creation_index` ON `agent_messages` (`session_id`,`is_deleted`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_messages_user_deletion_index` ON `agent_messages` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`runner_id` text NOT NULL,
	`provider_credential_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`working_directory` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`runner_id`) REFERENCES `runners`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`provider_credential_id`) REFERENCES `provider_credentials`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `agent_sessions_user_deletion_update_index` ON `agent_sessions` (`user_id`,`is_deleted`,`updated_at`);--> statement-breakpoint
CREATE INDEX `agent_sessions_runner_status_index` ON `agent_sessions` (`runner_id`,`status`);