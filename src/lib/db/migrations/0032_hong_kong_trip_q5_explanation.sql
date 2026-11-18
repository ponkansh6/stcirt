UPDATE `exam_questions`
SET `explanation` = 'Aは新鮮なロブスター、Bはフレンチトーストです。'
WHERE `id` = 5
  AND `question_key` = 'it-literacy-005'
  AND `question_version` = 'hong-kong-trip-a-b-v4';
