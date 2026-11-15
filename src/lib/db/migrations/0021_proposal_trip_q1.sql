UPDATE `exam_questions`
SET `question` = 'プロポーズを控えた長崎旅行。出発前の空港で起きたハプニングは？',
    `choices` = '["ラストコール10分前にダッシュしているところを珠美の友達に見られた","手荷物検査の際にプロポーズ用の指輪を珠美に見られそうになった","舜基がボーッとしていて手荷物を空港の飲食店に忘れて遅れそうになった","空港で偶然会社の同僚に遭遇し、旅行の目的を聞かれて焦った"]',
    `correct_index` = 0,
    `explanation` = 'ラストコール10分前にダッシュしているところを珠美の友達に見られました。',
    `question_version` = 'proposal-trip-v1'
WHERE `id` = 1 AND `question_key` = 'it-literacy-001';
