ALTER TABLE `agent_sessions` ADD `parent_callback_generation` integer;--> statement-breakpoint
UPDATE `agent_sessions` SET `parent_callback_generation` = `parent_execution_generation` WHERE `parent_execution_generation` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `spawn_preparation_pending` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `agent_sessions_parent_owner_deletion_index` ON `agent_sessions` (`parent_session_id`,`user_id`,`is_deleted`);