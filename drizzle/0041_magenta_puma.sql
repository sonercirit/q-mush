DROP INDEX `operation_envelopes_active_writer_sequence_unique`;--> statement-breakpoint
DROP INDEX `operation_envelopes_active_operation_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `operation_envelopes_active_writer_sequence_unique` ON `operation_envelopes` (`user_id`,`partition`,`writer_id`,`sequence`) WHERE NOT "operation_envelopes"."is_deleted";--> statement-breakpoint
CREATE UNIQUE INDEX `operation_envelopes_active_operation_id_unique` ON `operation_envelopes` (`user_id`,`partition`,`operation_id`) WHERE NOT "operation_envelopes"."is_deleted";