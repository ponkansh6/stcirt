CREATE TABLE `exam_answer_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question_id` integer NOT NULL,
	`selected_index` integer NOT NULL,
	`is_correct` integer NOT NULL,
	`answered_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `exam_questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `exam_answer_logs_question_id_idx` ON `exam_answer_logs` (`question_id`);--> statement-breakpoint
CREATE INDEX `exam_answer_logs_answered_at_idx` ON `exam_answer_logs` (`answered_at`);--> statement-breakpoint
CREATE INDEX `exam_answer_logs_question_answered_at_idx` ON `exam_answer_logs` (`question_id`,"answered_at" desc);--> statement-breakpoint
CREATE TABLE `exam_questions` (
	`id` integer PRIMARY KEY NOT NULL,
	`question_key` text NOT NULL,
	`question` text NOT NULL,
	`choices` text NOT NULL,
	`correct_index` integer NOT NULL,
	`explanation` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exam_questions_question_key_unique` ON `exam_questions` (`question_key`);
--> statement-breakpoint
INSERT OR IGNORE INTO `exam_questions` (`id`, `question_key`, `question`, `choices`, `correct_index`, `explanation`) VALUES
	(1, 'it-literacy-001', '差出人に心当たりのないメールに「アカウントが停止されます」と書かれ、リンクからログインするよう求められました。最も適切な対応はどれですか。', '["メール内のリンクを開いて、表示されたページで確認する","リンクは開かず、公式アプリやブックマークから正規のサイトにアクセスして確認する","メールに返信して、送信者の本人確認を依頼する","同じメールを同僚全員に転送して判断を任せる"]', 1, 'メール内のリンクは偽サイトへ誘導する可能性があります。リンクを開かず、普段使っている正規の経路から確認します。'),
	(2, 'it-literacy-002', '複数のサービスで同じパスワードを使っている場合、あるサービスからパスワードが漏えいしたときの被害を抑える方法として最も適切なのはどれですか。', '["すべてのサービスで同じパスワードを定期的に少しだけ変える","サービスごとに異なる強いパスワードを使い、多要素認証も有効にする","パスワードを忘れないよう、共有の表計算ファイルに記録する","ログイン通知をすべて無効にする"]', 1, 'サービスごとに異なるパスワードを使えば、ひとつの漏えいが他のサービスへ波及しにくくなります。多要素認証も有効です。'),
	(3, 'it-literacy-003', 'Webサイトのアドレスが「https://」で始まっていることから、確実に判断できる内容はどれですか。', '["そのサイトの運営者が信頼できる","サイトに掲載された情報が正確である","通信が暗号化されているが、運営者や内容の信頼性までは保証されない","ウイルスや詐欺の危険がない"]', 2, 'HTTPSは通信の暗号化を示します。サイトの運営者や掲載内容が信頼できることまでは保証しません。'),
	(4, 'it-literacy-004', 'ランサムウェアなどでパソコン内のファイルが使えなくなる事態に備える方法として、最も適切なのはどれですか。', '["同じパソコン内の別フォルダーにだけコピーする","定期的にバックアップし、バックアップ先は通常時に切り離すか世代管理する","ファイル名に「バックアップ」と付けて上書き保存する","復旧に備えてパスワードをパソコンに貼っておく"]', 1, '同じ端末だけに保存したコピーは、端末全体が侵害された際に一緒に失われる可能性があります。切り離したバックアップや世代管理が有効です。'),
	(5, 'it-literacy-005', '業務で受け取った顧客名簿を、個人のクラウドストレージに保存して自宅のパソコンから作業してよいか迷っています。最初に取るべき対応はどれですか。', '["作業効率を優先し、個人用ストレージに保存する","氏名をファイル名から削れば保存してよいと判断する","組織のルールと承認済みの保存・作業方法を確認する","作業後に削除すれば問題ないと考えて保存する"]', 2, '顧客情報の保存先や持ち出し方法は組織のルールに従い、承認済みの環境を使います。個人用サービスへの保存を自己判断で行いません。');
