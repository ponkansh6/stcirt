UPDATE `exam_questions`
SET `question` = replace(
      `question`,
      '3回目の旅程に関して以下を埋めてください。舜基は珠美の1年間の香港滞在中、3回香港に訪問した。',
      '舜基は珠美の1年間の香港滞在中、3回香港に訪問した。3回目の旅程に関して以下を埋めてください。'
    ),
    `question_version` = 'hong-kong-trip-a-b-v3'
WHERE `id` = 5
  AND `question_key` = 'it-literacy-005'
  AND `question_version` = 'hong-kong-trip-a-b-v2';
