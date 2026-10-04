CREATE TABLE IF NOT EXISTS `answer_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question_id` integer NOT NULL,
	`selected_index` integer NOT NULL,
	`is_correct` integer NOT NULL,
	`answered_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `answer_logs_question_id_idx` ON `answer_logs` (`question_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `answer_logs_answered_at_idx` ON `answer_logs` (`answered_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `answer_logs_question_answered_at_idx` ON `answer_logs` (`question_id`,"answered_at" desc);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `knowledge` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`source_text` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`knowledge_id` integer NOT NULL,
	`question` text NOT NULL,
	`choices` text NOT NULL,
	`correct_index` integer NOT NULL,
	`explanation` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`knowledge_id`) REFERENCES `knowledge`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `questions_knowledge_id_unique` ON `questions` (`knowledge_id`);
