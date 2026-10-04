CREATE TABLE `exam_participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`normalized_name` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exam_participants_normalized_name_unique` ON `exam_participants` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `participant_rate_limits` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`window_started_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `exam_answer_logs` ADD `participant_id` integer REFERENCES exam_participants(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `exam_answer_logs_participant_id_idx` ON `exam_answer_logs` (`participant_id`);
