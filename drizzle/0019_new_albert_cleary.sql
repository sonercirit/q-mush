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
	`sequence` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `agent_pending_inputs_session_deletion_sequence_index` ON `agent_pending_inputs` (`session_id`,`is_deleted`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_pending_inputs_session_sequence_unique` ON `agent_pending_inputs` (`session_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_pending_inputs_user_request_unique` ON `agent_pending_inputs` (`user_id`,`client_request_id`);--> statement-breakpoint
CREATE TABLE `agent_question_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`session_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`execution_generation` integer NOT NULL,
	`questions` text NOT NULL,
	`answers` text,
	`answered_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_question_requests_generation_nonnegative_check" CHECK("agent_question_requests"."execution_generation" >= 0)
);
--> statement-breakpoint
CREATE INDEX `agent_question_requests_session_deletion_index` ON `agent_question_requests` (`session_id`,`is_deleted`);--> statement-breakpoint
CREATE INDEX `agent_question_requests_user_deletion_index` ON `agent_question_requests` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_question_requests_session_tool_call_unique` ON `agent_question_requests` (`session_id`,`tool_call_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_question_requests_active_session_unique` ON `agent_question_requests` (`session_id`) WHERE "agent_question_requests"."answered_at" IS NULL AND NOT "agent_question_requests"."is_deleted";--> statement-breakpoint
CREATE TABLE `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`body` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "prompts_revision_positive_check" CHECK("prompts"."revision" > 0)
);
--> statement-breakpoint
CREATE INDEX `prompts_user_deletion_update_index` ON `prompts` (`user_id`,`is_deleted`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_user_normalized_name_active_unique` ON `prompts` (`user_id`,`normalized_name`) WHERE NOT "prompts"."is_deleted";--> statement-breakpoint
CREATE TABLE `provider_credential_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`provider_credential_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`provider_credential_id`) REFERENCES `provider_credentials`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `provider_credential_workspaces_user_deletion_index` ON `provider_credential_workspaces` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_credential_workspaces_active_unique` ON `provider_credential_workspaces` (`provider_credential_id`,`workspace_id`) WHERE NOT "provider_credential_workspaces"."is_deleted";--> statement-breakpoint
CREATE TABLE `runner_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`runner_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`runner_id`) REFERENCES `runners`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `runner_workspaces_user_deletion_index` ON `runner_workspaces` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE UNIQUE INDEX `runner_workspaces_active_unique` ON `runner_workspaces` (`runner_id`,`workspace_id`) WHERE NOT "runner_workspaces"."is_deleted";--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `workspaces_user_deletion_index` ON `workspaces` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_user_active_name_unique` ON `workspaces` (`user_id`,`name`) WHERE NOT "workspaces"."is_deleted";--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_user_default_unique` ON `workspaces` (`user_id`) WHERE NOT "workspaces"."is_deleted" AND "workspaces"."is_default";--> statement-breakpoint
INSERT INTO `workspaces`("id", "user_id", "name", "is_default", "created_at", "created_by_id", "updated_at", "updated_by_id", "is_deleted") SELECT "id", "id", 'Default', true, "created_at", "id", "updated_at", "id", "is_deleted" FROM `users`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`workspace_id` text NOT NULL,
	`parent_session_id` text,
	`parent_execution_generation` integer,
	`runner_id` text NOT NULL,
	`runner_required` integer DEFAULT false NOT NULL,
	`execution_generation` integer DEFAULT 0 NOT NULL,
	`current_segment` integer DEFAULT 0 NOT NULL,
	`restart_handoff` text,
	`provider_credential_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_pricing` text,
	`openrouter_provider_tag` text,
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
	`execution_environment` text DEFAULT 'bare_metal' NOT NULL,
	`working_directory` text NOT NULL,
	`title` text NOT NULL,
	`tools` text DEFAULT '["page_fetch","read","bash","edit","write","parallel","brave_search","ask_questions","spawn_session","browse_runner_directories","list_runners","list_sessions","get_session_options","read_session","reassign_session","send_to_session","continue_session","stop_session"]' NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`runner_id`) REFERENCES `runners`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`provider_credential_id`) REFERENCES `provider_credentials`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_sessions_current_segment_nonnegative_check" CHECK("__new_agent_sessions"."current_segment" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_agent_sessions`("id", "user_id", "created_at", "created_by_id", "updated_at", "updated_by_id", "is_deleted", "workspace_id", "parent_session_id", "parent_execution_generation", "runner_id", "runner_required", "execution_generation", "provider_credential_id", "provider", "provider_pricing", "model", "auto_compact", "active_duration_ms", "active_started_at", "cost_basis", "cost_usd", "current_context_tokens", "max_context_tokens", "agent_file_name", "agent_file_content", "reasoning_effort", "working_directory", "title", "tools", "status") SELECT "id", "user_id", "created_at", "created_by_id", "updated_at", "updated_by_id", "is_deleted", "user_id", "parent_session_id", "parent_execution_generation", "runner_id", "runner_required", "execution_generation", "provider_credential_id", "provider", "provider_pricing", "model", "auto_compact", "active_duration_ms", "active_started_at", "cost_basis", "cost_usd", "current_context_tokens", "max_context_tokens", "agent_file_name", "agent_file_content", "reasoning_effort", "working_directory", "title", "tools", "status" FROM `agent_sessions`;--> statement-breakpoint
DROP TABLE `agent_sessions`;--> statement-breakpoint
ALTER TABLE `__new_agent_sessions` RENAME TO `agent_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agent_sessions_user_workspace_deletion_update_index` ON `agent_sessions` (`user_id`,`workspace_id`,`is_deleted`,`updated_at`);--> statement-breakpoint
CREATE INDEX `agent_sessions_runner_status_index` ON `agent_sessions` (`runner_id`,`status`);--> statement-breakpoint
CREATE TABLE `__new_agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`session_id` text NOT NULL,
	`segment` integer DEFAULT 0 NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_call_id` text,
	`tool_name` text,
	`tool_calls` text,
	`images` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_messages_segment_nonnegative_check" CHECK("__new_agent_messages"."segment" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_agent_messages`("id", "user_id", "created_at", "created_by_id", "updated_at", "updated_by_id", "is_deleted", "session_id", "role", "content", "tool_call_id", "tool_name", "tool_calls", "images") SELECT "id", "user_id", "created_at", "created_by_id", "updated_at", "updated_by_id", "is_deleted", "session_id", "role", "content", "tool_call_id", "tool_name", "tool_calls", "images" FROM `agent_messages`;--> statement-breakpoint
DROP TABLE `agent_messages`;--> statement-breakpoint
ALTER TABLE `__new_agent_messages` RENAME TO `agent_messages`;--> statement-breakpoint
CREATE INDEX `agent_messages_session_deletion_creation_index` ON `agent_messages` (`session_id`,`is_deleted`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_messages_session_segment_creation_index` ON `agent_messages` (`session_id`,`segment`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_messages_user_deletion_index` ON `agent_messages` (`user_id`,`is_deleted`);--> statement-breakpoint
ALTER TABLE `provider_credentials` ADD `is_global` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_runners` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`name` text,
	`machine_fingerprint` text,
	`platform` text,
	`architecture` text,
	`token_hash` text NOT NULL,
	`token_digest` text DEFAULT '' NOT NULL,
	`activation_generation` integer DEFAULT 0 NOT NULL,
	`activation_id` text,
	`activation_phase` text,
	`activation_restart_id` text,
	`activation_lifecycle` text,
	`activation_lifecycle_settled` integer DEFAULT false NOT NULL,
	`activation_source_id` text,
	`activation_target_id` text,
	`activation_target_generation` integer,
	`activation_reservation_id` text,
	`activation_reservation_generation` integer,
	`activation_reservation_source_id` text,
	`activation_machine_fingerprint` text,
	`activation_platform` text,
	`activation_architecture` text,
	`activation_name` text,
	`last_seen_at` integer,
	`is_default` integer DEFAULT false NOT NULL,
	`is_global` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runners_activation_generation_nonnegative_check" CHECK("__new_runners"."activation_generation" >= 0),
	CONSTRAINT "runners_activation_phase_identity_check" CHECK(("__new_runners"."activation_phase" IS NULL AND "__new_runners"."activation_id" IS NULL AND "__new_runners"."activation_lifecycle" IS NULL) OR ("__new_runners"."activation_phase" IN ('prepared', 'finalized') AND "__new_runners"."activation_id" IS NOT NULL AND "__new_runners"."activation_lifecycle" IN ('ordinary', 'restart'))),
	CONSTRAINT "runners_activation_settlement_identity_check" CHECK("__new_runners"."activation_phase" IS NOT NULL OR NOT "__new_runners"."activation_lifecycle_settled"),
	CONSTRAINT "runners_activation_lifecycle_restart_check" CHECK(("__new_runners"."activation_lifecycle" IS NULL AND "__new_runners"."activation_restart_id" IS NULL) OR ("__new_runners"."activation_lifecycle" = 'ordinary' AND "__new_runners"."activation_restart_id" IS NULL) OR ("__new_runners"."activation_lifecycle" = 'restart' AND "__new_runners"."activation_restart_id" IS NOT NULL)),
	CONSTRAINT "runners_activation_scope_check" CHECK(("__new_runners"."activation_phase" IS NULL AND "__new_runners"."activation_source_id" IS NULL AND "__new_runners"."activation_target_id" IS NULL AND "__new_runners"."activation_target_generation" IS NULL AND "__new_runners"."activation_machine_fingerprint" IS NULL AND "__new_runners"."activation_platform" IS NULL AND "__new_runners"."activation_architecture" IS NULL AND "__new_runners"."activation_name" IS NULL) OR ("__new_runners"."activation_phase" IS NOT NULL AND "__new_runners"."activation_source_id" IS NOT NULL AND "__new_runners"."activation_target_id" IS NOT NULL AND "__new_runners"."activation_target_generation" IS NOT NULL AND "__new_runners"."activation_target_generation" >= 0 AND "__new_runners"."activation_machine_fingerprint" IS NOT NULL AND "__new_runners"."activation_platform" IS NOT NULL AND "__new_runners"."activation_architecture" IS NOT NULL AND "__new_runners"."activation_name" IS NOT NULL)),
	CONSTRAINT "runners_activation_reservation_check" CHECK(("__new_runners"."activation_reservation_id" IS NULL AND "__new_runners"."activation_reservation_generation" IS NULL AND "__new_runners"."activation_reservation_source_id" IS NULL) OR ("__new_runners"."activation_reservation_id" IS NOT NULL AND "__new_runners"."activation_reservation_generation" IS NOT NULL AND "__new_runners"."activation_reservation_generation" >= 0 AND "__new_runners"."activation_reservation_source_id" IS NOT NULL)),
	CONSTRAINT "runners_activation_settled_finalized_check" CHECK(NOT "__new_runners"."activation_lifecycle_settled" OR "__new_runners"."activation_phase" = 'finalized')
);
--> statement-breakpoint
INSERT INTO `__new_runners`("id", "user_id", "created_at", "created_by_id", "updated_at", "updated_by_id", "is_deleted", "name", "machine_fingerprint", "platform", "architecture", "token_hash", "last_seen_at", "is_default") SELECT "id", "user_id", "created_at", "created_by_id", "updated_at", "updated_by_id", "is_deleted", "name", "machine_fingerprint", "platform", "architecture", "token_hash", "last_seen_at", "is_default" FROM `runners`;--> statement-breakpoint
DROP TABLE `runners`;--> statement-breakpoint
ALTER TABLE `__new_runners` RENAME TO `runners`;--> statement-breakpoint
CREATE INDEX `runners_user_deletion_index` ON `runners` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE UNIQUE INDEX `runners_active_machine_unique` ON `runners` (`machine_fingerprint`) WHERE "runners"."is_deleted" = false;--> statement-breakpoint
CREATE UNIQUE INDEX `runners_active_token_digest_unique` ON `runners` (`token_digest`) WHERE "runners"."is_deleted" = false AND "runners"."token_digest" <> '';--> statement-breakpoint
CREATE UNIQUE INDEX `runners_active_activation_id_unique` ON `runners` (`activation_id`) WHERE "runners"."is_deleted" = false AND "runners"."activation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `runners_active_token_unique` ON `runners` (`token_hash`) WHERE "runners"."is_deleted" = false;--> statement-breakpoint
CREATE UNIQUE INDEX `runners_user_default_unique` ON `runners` (`user_id`) WHERE NOT "runners"."is_deleted" AND "runners"."is_default";