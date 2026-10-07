DELETE FROM `exam_answer_logs`;
--> statement-breakpoint
DELETE FROM `exam_answer_submissions`;
--> statement-breakpoint
DELETE FROM `presentation_sessions`;
--> statement-breakpoint
UPDATE `participant_result_settings` SET `visible` = false;
