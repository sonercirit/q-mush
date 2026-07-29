CREATE TABLE `agent_session_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`session_id` text NOT NULL,
	`execution_generation` integer NOT NULL,
	`boundary_message_id` text,
	`segment` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_session_turns_segment_nonnegative_check" CHECK("agent_session_turns"."segment" >= 0),
	CONSTRAINT "agent_session_turns_generation_nonnegative_check" CHECK("agent_session_turns"."execution_generation" >= 0),
	CONSTRAINT "agent_session_turns_end_check" CHECK("agent_session_turns"."ended_at" IS NULL OR "agent_session_turns"."ended_at" >= "agent_session_turns"."started_at")
);
--> statement-breakpoint
CREATE INDEX `agent_session_turns_session_segment_start_index` ON `agent_session_turns` (`session_id`,`segment`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_turns_active_session_unique` ON `agent_session_turns` (`session_id`) WHERE "agent_session_turns"."ended_at" IS NULL AND NOT "agent_session_turns"."is_deleted";--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `turn_id` text REFERENCES agent_session_turns(id) ON DELETE restrict;--> statement-breakpoint
CREATE INDEX `agent_messages_turn_index` ON `agent_messages` (`turn_id`);