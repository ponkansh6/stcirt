UPDATE `exam_questions`
SET `question` = '珠美が高校生のころ、バンドメンバーとライブの願掛けで食べていたものは？',
    `choices` = '["蕎麦屋のソースカツ丼","台湾料理屋のラーメン","マクドナルドのマックフルーリー","サイゼリヤの辛味チキン"]',
    `explanation` = '珠美は高校生のころ、バンドメンバーとライブの願掛けで台湾料理屋のラーメンを食べていました。',
    `question_version` = 'tamami-live-prayer-ramen-v2'
WHERE `id` = 3 AND `question_key` = 'it-literacy-003';
--> statement-breakpoint
UPDATE `exam_questions`
SET `question` = replace(`question`, '美味しいエビ入り飲茶を食べる', '近所で一番の高級飲茶を食べる'),
    `question_version` = 'hong-kong-trip-a-b-v6'
WHERE `id` = 5 AND `question_key` = 'it-literacy-005';
--> statement-breakpoint
UPDATE `exam_questions`
SET `question` = '新婦の大学生のころの友人グループが鈴木先生の部屋に集めていたものは？',
    `explanation` = '新婦の大学生のころの友人グループは、ご当地レトルトカレーを鈴木先生の部屋に集めていました。',
    `question_version` = 'tamami-university-friends-local-curry-v2'
WHERE `id` = 6 AND `question_key` = 'it-literacy-006';
--> statement-breakpoint
UPDATE `exam_questions`
SET `question` = '新郎が高校生のころの理数科で行ったグループ研究の内容は？',
    `explanation` = '新郎は高校生のころ、理数科で宇宙太陽光発電で使われるマイクロ波送電についてグループ研究を行いました。',
    `question_version` = 'shunki-high-school-microwave-power-v2'
WHERE `id` = 7 AND `question_key` = 'it-literacy-007';
