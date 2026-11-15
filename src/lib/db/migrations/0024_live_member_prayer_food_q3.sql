UPDATE `exam_questions`
SET `question` = '珠美が高校生のころ、ライブメンバーと願掛けで食べていたものは？',
    `choices` = '["蕎麦屋のカツ丼","中華料理屋のラーメン","うどん屋の海老天","サイゼリヤの辛味チキン"]',
    `correct_index` = 1,
    `correct_indices` = NULL,
    `selection_mode` = 'single',
    `explanation` = '珠美は高校生のころ、ライブメンバーと願掛けで中華料理屋のラーメンを食べていました。',
    `question_version` = 'tamami-live-prayer-ramen-v1'
WHERE `id` = 3 AND `question_key` = 'it-literacy-003';
