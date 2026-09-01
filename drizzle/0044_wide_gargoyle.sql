DROP INDEX `workspaces_user_active_name_unique`;--> statement-breakpoint
CREATE INDEX `workspaces_user_active_name_index` ON `workspaces` (`user_id`,`name`) WHERE NOT "workspaces"."is_deleted";