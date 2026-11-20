INSERT INTO `exam_questions` (
  `id`, `question_key`, `question`, `choices`, `correct_index`, `correct_indices`,
  `explanation`, `question_version`, `selection_mode`
) VALUES (
  7,
  'it-literacy-007',
  '新郎が高校時代に行った課題研究の内容は？',
  '["電磁誘導を利用したワイヤレス給電","風力発電の羽根の形状による発電効率の変化","宇宙太陽光発電で使われるマイクロ波送電","リニア等で活用される磁気浮上安定性の検証"]',
  2,
  NULL,
  '新郎は高校時代、宇宙太陽光発電で使われるマイクロ波送電について課題研究を行いました。',
  'shunki-high-school-microwave-power-v1',
  'single'
);
