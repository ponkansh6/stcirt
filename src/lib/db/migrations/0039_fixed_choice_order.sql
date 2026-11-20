-- Keep the correct answers spread across displayed positions while the
-- client preserves this persisted order for every attempt and presentation.
UPDATE `exam_questions`
SET `choices` = '["ラストコール10分前にダッシュしているところを珠美の友達に見られた","手荷物検査の際にプロポーズ用の指輪を珠美に見られそうになった","舜基がボーッとしていて手荷物を空港の飲食店に忘れて遅れそうになった","空港で偶然会社の同僚に遭遇し、旅行の目的を聞かれて焦った"]',
    `question_version` = 'proposal-trip-v2'
WHERE `id` = 1 AND `question_key` = 'it-literacy-001';
--> statement-breakpoint
UPDATE `exam_questions`
SET `choices` = '["シートベルトなし","日本語の練習内容紹介","窓が全開","ぶつけても気にせず走行","インド料理を延々と紹介","インド映画音楽が爆音","大量の象のストラップ","他の運転手と激しく口論"]',
    `correct_index` = 0,
    `correct_indices` = '[0,1]',
    `question_version` = 'india-uber-multi-v3'
WHERE `id` = 2 AND `question_key` = 'it-literacy-002';
--> statement-breakpoint
UPDATE `exam_questions`
SET `choices` = '["蕎麦屋のソースカツ丼","マクドナルドのマックフルーリー","台湾料理屋のラーメン","サイゼリヤの辛味チキン"]',
    `correct_index` = 2,
    `question_version` = 'tamami-live-prayer-ramen-v3'
WHERE `id` = 3 AND `question_key` = 'it-literacy-003';
--> statement-breakpoint
UPDATE `exam_questions`
SET `choices` = '["麺屋はなびのまぜそばメガ盛り","丸亀製麺の釜揚げうどん特盛","二郎系ラーメン豚山の大ラーメン","すき家のキング牛丼"]',
    `correct_index` = 3,
    `question_version` = 'shunki-tennis-team-king-beef-v3'
WHERE `id` = 4 AND `question_key` = 'it-literacy-004';
--> statement-breakpoint
UPDATE `exam_questions`
SET `choices` = '["ご当地レトルトカレー","ご当地ラーメン","ご当地ストラップ","ご当地じゃがりこ"]',
    `correct_index` = 0,
    `question_version` = 'tamami-university-friends-local-curry-v3'
WHERE `id` = 6 AND `question_key` = 'it-literacy-006';
--> statement-breakpoint
UPDATE `exam_questions`
SET `choices` = '["電磁誘導を利用したワイヤレス給電","宇宙太陽光発電で使われるマイクロ波送電","風力発電の羽根の形状による発電効率の変化","リニア等で活用される磁気浮上安定性の検証"]',
    `correct_index` = 1,
    `question_version` = 'shunki-high-school-microwave-power-v4'
WHERE `id` = 7 AND `question_key` = 'it-literacy-007';
