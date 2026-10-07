ALTER TABLE `exam_submission_answers` RENAME TO `exam_submission_answers_legacy`;
--> statement-breakpoint
CREATE TABLE `exam_submission_answers` (
	`submission_id` text NOT NULL REFERENCES `exam_answer_submissions`(`id`) ON DELETE CASCADE,
	`question_id` integer NOT NULL REFERENCES `exam_questions`(`id`) ON DELETE CASCADE,
	`selected_index` integer,
	`free_text` text,
	`answer_kind` text NOT NULL DEFAULT 'selected',
	PRIMARY KEY(`submission_id`, `question_id`),
	CHECK ((`answer_kind` = 'freeText' AND `selected_index` IS NULL AND `free_text` IS NOT NULL) OR (`answer_kind` IN ('selected', 'legacy') AND `selected_index` IS NOT NULL AND `free_text` IS NULL))
);
--> statement-breakpoint
INSERT INTO `exam_submission_answers` (`submission_id`, `question_id`, `selected_index`, `free_text`, `answer_kind`)
SELECT `submission_id`, `question_id`, `selected_index`, NULL,
	CASE WHEN `question_id` = 5 THEN 'legacy' ELSE 'selected' END
FROM `exam_submission_answers_legacy`;
--> statement-breakpoint
DROP TABLE `exam_submission_answers_legacy`;
--> statement-breakpoint
UPDATE `exam_questions`
SET `question` = '顧客名簿を使う業務を自宅で行う必要があります。個人のクラウドストレージと自宅のパソコンを使いたいと考えたとき、顧客情報を安全に扱うために、どのような対応を取りますか。利用の可否を確認する方法と、その理由を文章で説明してください。',
    `choices` = '[]',
    `correct_index` = 0,
    `explanation` = '顧客情報を個人のクラウドストレージや自宅のパソコンへ無断で保存・持ち出さない。まず組織の情報管理ルールを確認し、上司または情報システム担当者に利用の可否と許可された方法を相談する。作業が認められる場合は、組織が承認した保存先、端末、アクセス方法を使う。個人情報の漏えいや、意図しない共有・権限外アクセスを防ぐためである。'
WHERE `id` = 5;
--> statement-breakpoint
CREATE TABLE `exam_answer_assessments` (
	`submission_id` text NOT NULL REFERENCES `exam_answer_submissions`(`id`) ON DELETE CASCADE,
	`question_id` integer NOT NULL REFERENCES `exam_questions`(`id`) ON DELETE CASCADE,
	`revision` integer NOT NULL,
	`answer_text` text NOT NULL,
	`state` text NOT NULL,
	`claim_token` text,
	`raw_score` real,
	`normalized_score` real,
	`confidence` real,
	`model` text,
	`rubric_version` text NOT NULL,
	`attempts` integer NOT NULL DEFAULT 0,
	`next_attempt_at` integer,
	`graded_at` integer,
	`error_code` text,
	PRIMARY KEY(`submission_id`, `question_id`)
);
--> statement-breakpoint
CREATE INDEX `exam_answer_assessments_due_idx` ON `exam_answer_assessments` (`state`, `next_attempt_at`);
