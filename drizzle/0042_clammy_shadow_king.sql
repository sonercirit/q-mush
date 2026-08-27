DROP INDEX `operation_envelopes_owner_partition_writer_index`;--> statement-breakpoint
ALTER TABLE `operation_envelopes` ADD `sequence_order` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `operation_envelopes` SET `sequence_order` = printf('%05d:%s', length(`sequence`), `sequence`);--> statement-breakpoint
CREATE INDEX `operation_envelopes_owner_partition_writer_index` ON `operation_envelopes` (`user_id`,`partition`,`is_deleted`,`writer_id`,`sequence_order`);