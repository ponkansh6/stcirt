UPDATE `exam_questions`
SET `choices` = replace(`choices`, '日本語の練習内容紹介', '日本語練習中をアピール'),
    `question_version` = 'india-uber-multi-v5'
WHERE `id` = 2
  AND `question_key` = 'it-literacy-002'
  AND `question_version` = 'india-uber-multi-v4'
  AND `choices` LIKE '%日本語の練習内容紹介%';
