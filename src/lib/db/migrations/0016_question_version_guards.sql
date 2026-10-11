ALTER TABLE `exam_answer_assessments` ADD `question_version` text;--> statement-breakpoint
ALTER TABLE `exam_answer_submissions` ADD `question_versions` text;--> statement-breakpoint
ALTER TABLE `exam_questions` ADD `question_version` text;--> statement-breakpoint
ALTER TABLE `presentation_sessions` ADD `question_versions` text;--> statement-breakpoint
ALTER TABLE `presentation_sessions` ADD `rubric_versions` text;--> statement-breakpoint
UPDATE `exam_questions` SET `question_version` = 'nagano-001-v1' WHERE `id` = 1 AND `question_key` = 'it-literacy-001';--> statement-breakpoint
UPDATE `exam_questions` SET `question_version` = 'nagano-002-v1' WHERE `id` = 2 AND `question_key` = 'it-literacy-002';--> statement-breakpoint
UPDATE `exam_questions` SET `question_version` = 'nagano-003-v1' WHERE `id` = 3 AND `question_key` = 'it-literacy-003';--> statement-breakpoint
UPDATE `exam_questions` SET `question_version` = 'nagano-004-v1' WHERE `id` = 4 AND `question_key` = 'it-literacy-004';--> statement-breakpoint
UPDATE `exam_questions` SET `question_version` = 'tamami-egg-v1' WHERE `id` = 5 AND `question_key` = 'it-literacy-005';
