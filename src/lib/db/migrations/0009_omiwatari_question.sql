UPDATE `exam_questions`
SET `question` = '諏訪湖が全面結氷した後、氷が割れて筋状に盛り上がる現象を何といいますか？',
    `choices` = '[]',
    `correct_index` = 0,
    `explanation` = '御神渡り（おみわたり）は、冬に諏訪湖が全面結氷した後、氷が割れて筋状、山脈状に盛り上がる自然現象です。諏訪大社上社の男神が下社の女神のもとへ渡った道筋だという伝承があります。'
WHERE `id` = 5;
--> statement-breakpoint
UPDATE `exam_answer_assessments`
SET `rubric_version` = 'omiwatari-v1'
WHERE `question_id` = 5
  AND `state` = 'pending'
  AND `rubric_version` = 'customer-data-home-work-v1';
