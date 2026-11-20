UPDATE `exam_questions`
SET `question` = '珠美の大学生時代の友人グループが鈴木先生の部屋に集めていたものは？',
    `explanation` = '珠美の大学生時代の友人グループは、ご当地レトルトカレーを鈴木先生の部屋に集めていました。',
    `question_version` = 'tamami-university-friends-local-curry-v4'
WHERE `id` = 6
  AND `question_key` = 'it-literacy-006';
--> statement-breakpoint
UPDATE `exam_questions`
SET `question` = '舜基が高校生のころ、理数科で行ったグループ研究の内容は？',
    `explanation` = '舜基は高校生のころ、理数科で宇宙太陽光発電で使われるマイクロ波送電についてグループ研究を行いました。',
    `question_version` = 'shunki-high-school-microwave-power-v5'
WHERE `id` = 7
  AND `question_key` = 'it-literacy-007';
