UPDATE `exam_questions`
SET `question` = '長野県の県庁所在地は？',
    `choices` = '["長野市","松本市","上田市","佐久市"]',
    `correct_index` = 0,
    `explanation` = '長野市が長野県の県庁所在地です。'
WHERE `id` = 1 AND `question_key` = 'it-literacy-001';
--> statement-breakpoint
UPDATE `exam_questions`
SET `question` = '松本城がある市は？',
    `choices` = '["長野市","松本市","伊那市","飯田市"]',
    `correct_index` = 1,
    `explanation` = '松本城は松本市にあります。'
WHERE `id` = 2 AND `question_key` = 'it-literacy-002';
--> statement-breakpoint
UPDATE `exam_questions`
SET `question` = '長野県の名物のそばは？',
    `choices` = '["信州そば","わんこそば","出雲そば","沖縄そば"]',
    `correct_index` = 0,
    `explanation` = '信州そばは長野県の名物です。'
WHERE `id` = 3 AND `question_key` = 'it-literacy-003';
--> statement-breakpoint
UPDATE `exam_questions`
SET `question` = '長野県で多く作られている果物のひとつは？',
    `choices` = '["りんご","バナナ","マンゴー","パイナップル"]',
    `correct_index` = 0,
    `explanation` = 'りんごは長野県を代表する果物のひとつです。'
WHERE `id` = 4 AND `question_key` = 'it-literacy-004';
