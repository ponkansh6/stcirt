ALTER TABLE `exam_questions` ADD COLUMN `correct_indices` text;
--> statement-breakpoint
ALTER TABLE `exam_questions` ADD COLUMN `selection_mode` text NOT NULL DEFAULT 'single';
--> statement-breakpoint
ALTER TABLE `exam_submission_answers` RENAME TO `exam_submission_answers_legacy`;
--> statement-breakpoint
CREATE TABLE `exam_submission_answers` (
	`submission_id` text NOT NULL REFERENCES `exam_answer_submissions`(`id`) ON DELETE CASCADE,
	`question_id` integer NOT NULL REFERENCES `exam_questions`(`id`) ON DELETE CASCADE,
	`selected_index` integer,
	`selected_indices` text,
	`free_text` text,
	`answer_kind` text NOT NULL DEFAULT 'selected',
	PRIMARY KEY(`submission_id`, `question_id`),
	CHECK ((`answer_kind` = 'freeText' AND `selected_index` IS NULL AND `selected_indices` IS NULL AND `free_text` IS NOT NULL) OR (`answer_kind` = 'selected' AND `free_text` IS NULL AND ((`selected_index` IS NOT NULL AND `selected_indices` IS NULL) OR (`selected_index` IS NULL AND `selected_indices` IS NOT NULL))) OR (`answer_kind` = 'legacy' AND `selected_index` IS NOT NULL AND `selected_indices` IS NULL AND `free_text` IS NULL))
);
--> statement-breakpoint
INSERT INTO `exam_submission_answers` (`submission_id`, `question_id`, `selected_index`, `selected_indices`, `free_text`, `answer_kind`)
SELECT `submission_id`, `question_id`, `selected_index`, NULL, `free_text`, `answer_kind`
FROM `exam_submission_answers_legacy`;
--> statement-breakpoint
DROP TABLE `exam_submission_answers_legacy`;
--> statement-breakpoint
ALTER TABLE `presentation_questions` ADD COLUMN `correct_indices` text;
--> statement-breakpoint
UPDATE `exam_questions`
SET `question` = 'インド出張の時に舜基と珠美が乗ったUberタクシーはどんなタクシーだった？（2つ選択）',
    `choices` = '["おすすめのインド料理を最初から最後まで語っていた","シートベルトがなかった","運転手がほかの運転手と激しい口論を始めてしまった","運転手が道に迷い、乗客にナビを任せてきた","運転手が日本語の練習中だった","車内でインド映画の音楽が大音量で流れていた","車内に象のストラップがたくさん飾られていた","エアコンが壊れていて窓が全開だった"]',
    `correct_index` = 1,
    `correct_indices` = '[1,4]',
    `selection_mode` = 'multiple',
    `explanation` = 'シートベルトがなく、運転手は日本語の練習中でした。',
    `question_version` = 'india-uber-multi-v1'
WHERE `id` = 2 AND `question_key` = 'it-literacy-002';
