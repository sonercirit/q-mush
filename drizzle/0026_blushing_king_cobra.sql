CREATE TABLE `agent_session_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`session_id` text NOT NULL,
	`execution_generation` integer NOT NULL,
	`operation` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_operations_active_generation_unique` ON `agent_session_operations` (`session_id`,`execution_generation`) WHERE NOT "agent_session_operations"."is_deleted";