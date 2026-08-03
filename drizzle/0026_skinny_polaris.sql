ALTER TABLE `agent_messages` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `cached_input_tokens` integer;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `cache_write_input_tokens` integer;