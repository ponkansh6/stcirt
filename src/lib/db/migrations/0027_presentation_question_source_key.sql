ALTER TABLE `presentation_questions` ADD COLUMN `source_question_key` text;
--> statement-breakpoint
UPDATE `presentation_questions`
SET `source_question_key` = (
  SELECT `key`
  FROM `exam_questions`
  WHERE `exam_questions`.`id` = `presentation_questions`.`source_question_id`
);
