CREATE TABLE `exam_answer_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`participant_id` integer NOT NULL REFERENCES exam_participants(id) ON DELETE CASCADE,
	`question_ids` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `exam_submission_answers` (
	`submission_id` text NOT NULL REFERENCES exam_answer_submissions(id) ON DELETE CASCADE,
	`question_id` integer NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
	`selected_index` integer NOT NULL,
	PRIMARY KEY(`submission_id`, `question_id`)
);
--> statement-breakpoint
CREATE TABLE `exam_submission_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL REFERENCES exam_answer_submissions(id) ON DELETE CASCADE,
	`payload` text NOT NULL,
	`revision` integer NOT NULL
);
