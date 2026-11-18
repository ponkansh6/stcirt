UPDATE `exam_questions`
SET `question` = '舜基が大学生のころ、テニスサークルの団体戦練習後にチームメンバーと食べていたものは？',
    `choices` = '["麺屋はなびのまぜそばメガ盛り","すき家のキング牛丼","丸亀製麺の釜揚げうどん特盛","二郎系ラーメン豚山の大ラーメン"]',
    `correct_index` = 1,
    `correct_indices` = NULL,
    `selection_mode` = 'single',
    `explanation` = '舜基は大学生のころ、テニスサークルの団体戦練習後にチームメンバーと時々すき家のキング牛丼を食べていました。',
    `question_version` = 'shunki-tennis-team-king-beef-v1'
WHERE `id` = 4 AND `question_key` = 'it-literacy-004';
