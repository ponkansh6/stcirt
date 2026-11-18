UPDATE `exam_questions`
SET `choices` = '["窓が全開","ぶつけても気にせず走行","シートベルトなし","日本語の練習内容紹介","インド料理を延々と紹介","インド映画音楽が爆音","大量の象のストラップ","他の運転手と激しく口論"]',
    `correct_index` = 2,
    `correct_indices` = '[2,3]',
    `explanation` = 'シートベルトがなく、運転手は日本語の練習中でした。',
    `question_version` = 'india-uber-multi-v2'
WHERE `id` = 2
  AND `question_key` = 'it-literacy-002'
  AND `question_version` = 'india-uber-multi-v1';
