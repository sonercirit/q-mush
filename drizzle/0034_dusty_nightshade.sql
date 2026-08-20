CREATE TABLE `tool_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`execution_limit_minutes` integer NOT NULL,
	`output_limit_characters` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tool_settings_execution_range_check" CHECK("tool_settings"."execution_limit_minutes" >= 1 AND "tool_settings"."execution_limit_minutes" <= 35791),
	CONSTRAINT "tool_settings_output_range_check" CHECK("tool_settings"."output_limit_characters" >= 2000 AND "tool_settings"."output_limit_characters" <= 22369409)
);
--> statement-breakpoint
CREATE INDEX `tool_settings_user_deletion_index` ON `tool_settings` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE UNIQUE INDEX `tool_settings_user_active_unique` ON `tool_settings` (`user_id`) WHERE NOT "tool_settings"."is_deleted";--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- Turn tool-setting defaults mirror DEFAULT_TOOL_SETTINGS in shared/tool-limits.ts.
CREATE TABLE `__new_agent_session_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`boundary_message_id` text,
	`ended_at` integer,
	`execution_generation` integer NOT NULL,
	`segment` integer DEFAULT 0 NOT NULL,
	`session_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`tool_execution_limit_minutes` integer DEFAULT 30 NOT NULL,
	`tool_output_limit_characters` integer DEFAULT 20000 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_session_turns_segment_nonnegative_check" CHECK("__new_agent_session_turns"."segment" >= 0),
	CONSTRAINT "agent_session_turns_generation_nonnegative_check" CHECK("__new_agent_session_turns"."execution_generation" >= 0),
	CONSTRAINT "agent_session_turns_tool_execution_range_check" CHECK("__new_agent_session_turns"."tool_execution_limit_minutes" >= 1 AND "__new_agent_session_turns"."tool_execution_limit_minutes" <= 35791),
	CONSTRAINT "agent_session_turns_tool_output_range_check" CHECK("__new_agent_session_turns"."tool_output_limit_characters" >= 2000 AND "__new_agent_session_turns"."tool_output_limit_characters" <= 22369409),
	CONSTRAINT "agent_session_turns_end_check" CHECK("__new_agent_session_turns"."ended_at" IS NULL OR "__new_agent_session_turns"."ended_at" >= "__new_agent_session_turns"."started_at")
);
--> statement-breakpoint
INSERT INTO `__new_agent_session_turns`("id", "user_id", "created_at", "created_by_id", "updated_at", "updated_by_id", "is_deleted", "boundary_message_id", "ended_at", "execution_generation", "segment", "session_id", "started_at") SELECT "id", "user_id", "created_at", "created_by_id", "updated_at", "updated_by_id", "is_deleted", "boundary_message_id", "ended_at", "execution_generation", "segment", "session_id", "started_at" FROM `agent_session_turns`;--> statement-breakpoint
DROP TABLE `agent_session_turns`;--> statement-breakpoint
ALTER TABLE `__new_agent_session_turns` RENAME TO `agent_session_turns`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agent_session_turns_session_segment_start_index` ON `agent_session_turns` (`session_id`,`segment`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_turns_active_session_unique` ON `agent_session_turns` (`session_id`) WHERE "agent_session_turns"."ended_at" IS NULL AND NOT "agent_session_turns"."is_deleted";
