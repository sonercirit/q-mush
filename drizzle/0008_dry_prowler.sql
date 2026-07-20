ALTER TABLE `agent_sessions` ADD `current_context_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `max_context_tokens` integer;