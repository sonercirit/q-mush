CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`google_subject` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`picture` text,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
WITH `migration_clock` AS MATERIALIZED (
	SELECT cast(unixepoch('subsec') * 1000 AS integer) AS `migration_time`
),
`source_users` AS MATERIALIZED (
	SELECT
		`users`.*,
		`migration_clock`.`migration_time`,
		printf('%012x', `migration_clock`.`migration_time`) AS `timestamp_hex`
	FROM `users`
	CROSS JOIN `migration_clock`
)
INSERT INTO `__new_users` (
	`id`,
	`google_subject`,
	`email`,
	`name`,
	`picture`,
	`created_at`,
	`created_by_id`,
	`updated_at`,
	`updated_by_id`,
	`is_deleted`
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
	`id`,
	`email`,
	`name`,
	`picture`,
	coalesce(
		(
			SELECT min(`sessions`.`expires_at` - 604800000)
			FROM `sessions`
			WHERE `sessions`.`user_id` = `source_users`.`id`
		),
		`migration_time`
	),
	'SYSTEM',
	`migration_time`,
	'SYSTEM',
	false
FROM `source_users`;
--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_id` text NOT NULL,
	`is_deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `__new_users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
WITH `migration_clock` AS MATERIALIZED (
	SELECT cast(unixepoch('subsec') * 1000 AS integer) AS `migration_time`
),
`source_sessions` AS MATERIALIZED (
	SELECT
		`sessions`.*,
		`migration_clock`.`migration_time`,
		printf('%012x', `migration_clock`.`migration_time`) AS `timestamp_hex`
	FROM `sessions`
	CROSS JOIN `migration_clock`
)
INSERT INTO `__new_sessions` (
	`id`,
	`token`,
	`user_id`,
	`expires_at`,
	`created_at`,
	`created_by_id`,
	`updated_at`,
	`updated_by_id`,
	`is_deleted`
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
	`source_sessions`.`id`,
	`__new_users`.`id`,
	`source_sessions`.`expires_at`,
	`source_sessions`.`expires_at` - 604800000,
	`__new_users`.`id`,
	`source_sessions`.`migration_time`,
	'SYSTEM',
	false
FROM `source_sessions`
INNER JOIN `__new_users`
	ON `__new_users`.`google_subject` = `source_sessions`.`user_id`;
--> statement-breakpoint
DROP TABLE `sessions`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;
--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_subject_unique` ON `users` (`google_subject`);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);
--> statement-breakpoint
CREATE INDEX `sessions_user_id_index` ON `sessions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `sessions_deletion_expiry_index` ON `sessions` (`is_deleted`,`expires_at`);
