CREATE INDEX `agent_messages_user_id_index` ON `agent_messages` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `agent_pending_inputs_user_id_index` ON `agent_pending_inputs` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `agent_question_requests_user_id_index` ON `agent_question_requests` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `agent_session_operations_user_id_index` ON `agent_session_operations` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `agent_session_turns_user_id_index` ON `agent_session_turns` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `agent_sessions_user_id_index` ON `agent_sessions` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `attachment_fallbacks_user_id_index` ON `attachment_fallbacks` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `prompts_user_id_index` ON `prompts` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `provider_credential_workspaces_user_id_index` ON `provider_credential_workspaces` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `provider_credentials_user_id_index` ON `provider_credentials` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `provider_quota_reset_receipts_user_id_index` ON `provider_quota_reset_receipts` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `provider_quota_settings_user_id_index` ON `provider_quota_settings` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `runner_workspaces_user_id_index` ON `runner_workspaces` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `runners_user_id_index` ON `runners` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `tool_settings_user_id_index` ON `tool_settings` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `workspaces_user_id_index` ON `workspaces` (`user_id`,`id`);