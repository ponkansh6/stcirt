CREATE TABLE `presentation_entries_new` (
	`session_id` integer NOT NULL,
	`participant_id` integer NOT NULL,
	`display_name` text NOT NULL,
	`score` integer NOT NULL,
	`rank` integer,
	`is_aggregation_target` integer DEFAULT true NOT NULL,
	`is_reference` integer DEFAULT false NOT NULL,
	`equivalent_rank` integer,
	`answers` text NOT NULL,
	PRIMARY KEY(`session_id`, `participant_id`),
	FOREIGN KEY (`session_id`) REFERENCES `presentation_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `presentation_entries_new` (`session_id`, `participant_id`, `display_name`, `score`, `rank`, `is_aggregation_target`, `is_reference`, `equivalent_rank`, `answers`)
SELECT `session_id`, `participant_id`, `display_name`, `score`, CASE WHEN `is_aggregation_target` THEN `rank` ELSE NULL END, `is_aggregation_target`, false, NULL, `answers`
FROM `presentation_entries`;
--> statement-breakpoint
DROP TABLE `presentation_entries`;
--> statement-breakpoint
ALTER TABLE `presentation_entries_new` RENAME TO `presentation_entries`;
--> statement-breakpoint
CREATE TABLE `presentation_reference_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`names` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
