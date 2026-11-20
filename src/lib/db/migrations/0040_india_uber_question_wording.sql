UPDATE `exam_questions`
SET `question` = 'インド出張の時に舜基と珠美が乗ったのは、どんなUberタクシー？',
    `question_version` = 'india-uber-multi-v4'
WHERE `id` = 2
  AND `question_key` = 'it-literacy-002'
  AND `question_version` = 'india-uber-multi-v3';
