PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`parent_session_id` text,
	`runner_id` text NOT NULL,
	`provider_credential_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_pricing` text,
	`model` text NOT NULL,
	`auto_compact` integer DEFAULT true NOT NULL,
	`active_duration_ms` integer DEFAULT 0 NOT NULL,
	`active_started_at` integer,
	`cost_basis` text DEFAULT 'none' NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`current_context_tokens` integer DEFAULT 0 NOT NULL,
	`max_context_tokens` integer,
	`agent_file_name` text,
	`agent_file_content` text,
	`reasoning_effort` text,
	`working_directory` text NOT NULL,
	`title` text NOT NULL,
	`tools` text DEFAULT '["read","bash","edit","write","parallel","brave_search","spawn_session","list_sessions","read_session","send_to_session","continue_session","stop_session"]' NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`runner_id`) REFERENCES `runners`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`provider_credential_id`) REFERENCES `provider_credentials`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_agent_sessions`("id", "user_id", "created_at", "created_by_id", "updated_at", "updated_by_id", "is_deleted", "runner_id", "provider_credential_id", "provider", "provider_pricing", "model", "auto_compact", "active_duration_ms", "active_started_at", "cost_basis", "cost_usd", "current_context_tokens", "max_context_tokens", "agent_file_name", "agent_file_content", "reasoning_effort", "working_directory", "title", "tools", "status") SELECT "id", "user_id", "created_at", "created_by_id", "updated_at", "updated_by_id", "is_deleted", "runner_id", "provider_credential_id", "provider", "provider_pricing", "model", "auto_compact", "active_duration_ms", "active_started_at", "cost_basis", "cost_usd", "current_context_tokens", "max_context_tokens", "agent_file_name", "agent_file_content", "reasoning_effort", "working_directory", "title", "tools", "status" FROM `agent_sessions`;--> statement-breakpoint
DROP TABLE `agent_sessions`;--> statement-breakpoint
ALTER TABLE `__new_agent_sessions` RENAME TO `agent_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agent_sessions_user_deletion_update_index` ON `agent_sessions` (`user_id`,`is_deleted`,`updated_at`);--> statement-breakpoint
CREATE INDEX `agent_sessions_runner_status_index` ON `agent_sessions` (`runner_id`,`status`);
