UPDATE `exam_questions`
SET `question` = replace(`question`, '地元の少しリッチな飲茶を食べる', '美味しいエビ入り飲茶を食べる'),
    `question_version` = 'hong-kong-trip-a-b-v5'
WHERE `id` = 5
  AND `question_key` = 'it-literacy-005'
  AND `question_version` = 'hong-kong-trip-a-b-v4';
