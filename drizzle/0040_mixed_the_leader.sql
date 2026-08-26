CREATE TABLE `operation_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`partition` text NOT NULL,
	`encoded_checkpoint` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operation_checkpoints_active_owner_partition_unique` ON `operation_checkpoints` (`user_id`,`partition`) WHERE NOT "operation_checkpoints"."is_deleted";--> statement-breakpoint
CREATE TABLE `operation_envelopes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	`partition` text NOT NULL,
	`writer_id` text NOT NULL,
	`sequence` text NOT NULL,
	`operation_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`encoded_envelope` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operation_envelopes_active_writer_sequence_unique` ON `operation_envelopes` (`user_id`,`writer_id`,`sequence`) WHERE NOT "operation_envelopes"."is_deleted";--> statement-breakpoint
CREATE UNIQUE INDEX `operation_envelopes_active_operation_id_unique` ON `operation_envelopes` (`user_id`,`operation_id`) WHERE NOT "operation_envelopes"."is_deleted";--> statement-breakpoint
CREATE INDEX `operation_envelopes_owner_partition_writer_index` ON `operation_envelopes` (`user_id`,`partition`,`writer_id`,`sequence`);