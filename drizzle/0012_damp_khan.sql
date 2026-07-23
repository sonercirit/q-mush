ALTER TABLE `agent_sessions` ADD `provider_pricing` text;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `active_duration_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `active_started_at` integer;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `cost_basis` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `cost_usd` real DEFAULT 0 NOT NULL;