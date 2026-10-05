CREATE TABLE `presentation_entries` (
	`session_id` integer NOT NULL,
	`participant_id` integer NOT NULL,
	`display_name` text NOT NULL,
	`score` integer NOT NULL,
	`rank` integer NOT NULL,
	`answers` text NOT NULL,
	PRIMARY KEY(`session_id`, `participant_id`),
	FOREIGN KEY (`session_id`) REFERENCES `presentation_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `presentation_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`version` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `presentation_questions` (
	`session_id` integer NOT NULL,
	`position` integer NOT NULL,
	`source_question_id` integer NOT NULL,
	`question` text NOT NULL,
	`choices` text NOT NULL,
	`correct_index` integer NOT NULL,
	`explanation` text,
	PRIMARY KEY(`session_id`, `position`),
	FOREIGN KEY (`session_id`) REFERENCES `presentation_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `presentation_sessions` (
	`id` integer PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`version` integer NOT NULL,
	`question_index` integer NOT NULL,
	`question_count` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
