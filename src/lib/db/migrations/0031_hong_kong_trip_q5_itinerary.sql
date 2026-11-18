UPDATE `exam_questions`
SET `question` = replace('舜基は珠美の1年間の香港滞在中、3回香港に訪問した。3回目の旅程に関して以下を埋めてください。\n2/27 昼 マンダリンオリエンタルホテルのスコーンを食べる\n2/27 夜 香港で評価の高いフォカッチャパニーニを食べる\n2/28 朝 ローカルシーフードレストランでAを食べる\n2/28 昼 アバディーンでボートツアー＆ボートヌードル\n2/28 夜 地元で人気なローストグースを食べる\n3/1 朝 地元の少しリッチな飲茶を食べる\n3/1 昼夜 香港ディズニーランドを楽しむ\n3/2 朝 Bを食べる', char(92)||'n', char(10)),
    `choices` = '[]',
    `correct_index` = 0,
    `explanation` = 'Aは新鮮なロブスター、Bはフレンチトーストです。各1点満点で独立して採点します。',
    `question_version` = 'hong-kong-trip-a-b-v4'
WHERE `id` = 5
  AND `question_key` = 'it-literacy-005'
  AND `question_version` = 'hong-kong-trip-a-b-v3';
