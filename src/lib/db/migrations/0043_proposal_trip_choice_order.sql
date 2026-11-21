UPDATE `exam_questions`
SET `choices` = '["舜基がボーッとしていて手荷物を空港の飲食店に忘れて遅れそうになった","手荷物検査の際にプロポーズ用の指輪を珠美に見られそうになった","ラストコール10分前にダッシュしているところを珠美の友達に見られた","空港で偶然会社の同僚に遭遇し、旅行の目的を聞かれて焦った"]',
    `correct_index` = 2,
    `question_version` = 'proposal-trip-v3'
WHERE `id` = 1
  AND `question_key` = 'it-literacy-001'
  AND `question_version` = 'proposal-trip-v2';
