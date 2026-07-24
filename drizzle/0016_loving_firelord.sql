PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
);--> statement-breakpoint
CREATE INDEX `workspaces_user_deletion_index` ON `workspaces` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_user_active_name_unique` ON `workspaces` (`user_id`,`name`) WHERE NOT "workspaces"."is_deleted";--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_user_default_unique` ON `workspaces` (`user_id`) WHERE NOT "workspaces"."is_deleted" AND "workspaces"."is_default";--> statement-breakpoint
WITH `migration_clock` AS MATERIALIZED (
  SELECT cast(unixepoch('subsec') * 1000 AS integer) AS `migration_time`
),
`workspace_users` AS MATERIALIZED (
  SELECT
    `users`.*,
    `migration_clock`.`migration_time`,
    printf('%012x', `migration_clock`.`migration_time`) AS `timestamp_hex`
  FROM `users`
  CROSS JOIN `migration_clock`
)
INSERT INTO `workspaces` (
  `id`, `user_id`, `name`, `is_default`, `created_at`, `created_by_id`,
  `updated_at`, `updated_by_id`, `is_deleted`
)
SELECT
  lower(
    substr(`timestamp_hex`, 1, 8) || '-' ||
    substr(`timestamp_hex`, 9, 4) || '-7' ||
    substr(hex(randomblob(2)), 2, 3) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) ||
    substr(hex(randomblob(2)), 2, 3) || '-' ||
    hex(randomblob(6))
  ),
  `id`, 'Default', true, `created_at`, `id`, `updated_at`, `id`, false
FROM `workspace_users`;--> statement-breakpoint
CREATE TABLE `provider_credential_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_credential_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`provider_credential_id`) REFERENCES `provider_credentials`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX `provider_credential_workspaces_user_deletion_index` ON `provider_credential_workspaces` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_credential_workspaces_active_unique` ON `provider_credential_workspaces` (`provider_credential_id`,`workspace_id`) WHERE NOT "provider_credential_workspaces"."is_deleted";--> statement-breakpoint
CREATE TABLE `runner_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`runner_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`runner_id`) REFERENCES `runners`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX `runner_workspaces_user_deletion_index` ON `runner_workspaces` (`user_id`,`is_deleted`);--> statement-breakpoint
CREATE UNIQUE INDEX `runner_workspaces_active_unique` ON `runner_workspaces` (`runner_id`,`workspace_id`) WHERE NOT "runner_workspaces"."is_deleted";--> statement-breakpoint
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
	`tools` text DEFAULT '["read","bash","edit","write","spawn_session","list_sessions","read_session","send_to_session","continue_session","stop_session","parallel","brave_search"]' NOT NULL,
	`status` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`runner_id`) REFERENCES `runners`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`provider_credential_id`) REFERENCES `provider_credentials`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `__new_agent_sessions` (
  `id`, `user_id`, `created_at`, `created_by_id`, `updated_at`, `updated_by_id`,
  `is_deleted`, `workspace_id`, `parent_session_id`, `runner_id`,
  `provider_credential_id`, `provider`, `provider_pricing`, `model`,
  `auto_compact`, `active_duration_ms`, `active_started_at`, `cost_basis`,
  `cost_usd`, `current_context_tokens`, `max_context_tokens`, `agent_file_name`,
  `agent_file_content`, `reasoning_effort`, `working_directory`, `title`, `tools`,
  `status`
)
SELECT
  s.`id`, s.`user_id`, s.`created_at`, s.`created_by_id`, s.`updated_at`,
  s.`updated_by_id`, s.`is_deleted`, w.`id`, s.`parent_session_id`, s.`runner_id`,
  s.`provider_credential_id`, s.`provider`, s.`provider_pricing`, s.`model`,
  s.`auto_compact`, s.`active_duration_ms`, s.`active_started_at`, s.`cost_basis`,
  s.`cost_usd`, s.`current_context_tokens`, s.`max_context_tokens`,
  s.`agent_file_name`, s.`agent_file_content`, s.`reasoning_effort`,
  s.`working_directory`, s.`title`, s.`tools`, s.`status`
FROM `agent_sessions` s
JOIN `workspaces` w ON w.`user_id` = s.`user_id` AND w.`is_default` = true
WHERE NOT w.`is_deleted`;--> statement-breakpoint
DROP TABLE `agent_sessions`;--> statement-breakpoint
ALTER TABLE `__new_agent_sessions` RENAME TO `agent_sessions`;--> statement-breakpoint
CREATE INDEX `agent_sessions_user_workspace_deletion_update_index` ON `agent_sessions` (`user_id`,`workspace_id`,`is_deleted`,`updated_at`);--> statement-breakpoint
CREATE INDEX `agent_sessions_runner_status_index` ON `agent_sessions` (`runner_id`,`status`);--> statement-breakpoint
ALTER TABLE `provider_credentials` ADD `is_global` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `runners` ADD `is_global` integer DEFAULT true NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=ON;
