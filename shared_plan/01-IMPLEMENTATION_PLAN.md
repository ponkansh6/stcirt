# Study アプリ再設計プラン: 1ナレッジ1問 / 作成・解答の分離 / モバイル最適化

## Context

現状のプロトタイプは「ナレッジ本文を貼る → 10問のクイズセットを生成 → 10問まとめて解答 → 採点」という設計になっており、期待する学習体験と4点ずれている。

| #   | 期待                                       | 現状                                                                       | 根因                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 1ナレッジから **1問**                      | 10問生成                                                                   | `src/lib/llm/prompts.ts:1` が "exactly 10 questions" を要求。`src/lib/llm/schemas.ts:10` が `.length(10)`、`src/app/api/quiz-sets/route.ts:17` が `length !== 10` で拒否                                                                              |
| 2   | 問題→解答→問題 のサイクル                  | 10問全部答えてから一括採点                                                 | `QuizRunner.tsx:49-52` の `handleSubmit` が全問回答必須(`allAnswered`)。フィードバックは最後にまとめて表示                                                                                                                                            |
| 3   | 作成と解答を分離。解答は過去問からランダム | 生成直後にそのセットへリダイレクト。他セットを解くにはホームの一覧から選ぶ | `src/app/page.tsx:58` が `router.push(/quiz/${id})`。ランダム出題の導線・APIが存在しない                                                                                                                                                              |
| 4   | モバイル最適化                             | デスクトップ優先                                                           | `globals.css:46` が `max-width:900px` 固定。メディアクエリは `styles.module.css:214` の1ブロックのみ。`page.module.css` にはモバイル対応が皆無。10個の問題インジケータ(`QuizRunner.tsx:134-146`)が狭幅で破綻。`viewport-fit=cover` / safe-area 未対応 |

**目指す姿**: ホームから「問題を作る」「問題を解く」の2導線に分岐。作成はナレッジ1件→1問を作って終わり。解答は過去に作った問題から苦手優先のランダムで1問ずつ出題し、即フィードバックして次の問題へ無限に続く。全画面をモバイルファーストで作り直す。

**確定済みの設計判断** (ユーザー選択):

- データモデルは新スキーマに再設計。既存プロトタイプデータは破棄 (`src/lib/db/migrations` は未生成、`db:push` 運用のため作り直しコストは低い)
- 解答セッションはエンドレス。ユーザーが好きなタイミングで終了
- 解答履歴を永続化し、苦手優先の重み付けランダムで出題
- CSS Modules を廃止し Tailwind v4 でモバイルファーストに書き直し

---

## 1. データモデル

`src/lib/db/schema.ts` を全面書き換え。`quiz_sets` / `questions`(1:10) を廃止し以下に。

```ts
// knowledge: ユーザーが投入したナレッジ本文
knowledge      id, title, sourceText, createdAt

// questions: knowledge と 1:1。knowledgeId に unique 制約
questions      id, knowledgeId(unique, FK cascade), question,
               choices(json string[]), correctIndex, explanation, createdAt

// answerLogs: 解答履歴。苦手優先の重み付けと統計の元データ
answerLogs     id, questionId(FK cascade), selectedIndex, isCorrect(int bool), answeredAt
               index: (questionId), (answeredAt)
```

`orderIndex` は 1:1 になるため廃止。`quizSetId` は `knowledgeId` に置き換え。

`src/types/quiz.ts` も対応する型 (`Knowledge`, `Question`, `AnswerLog`, `QuestionForAnswering`) に置き換える。

---

## 2. 問題生成: 10問 → 1問

- `src/lib/llm/prompts.ts` — プロンプトを「1問だけ生成」に書き換え。返り値を配列から**単一オブジェクト**に変更。ナレッジの中核概念を突く1問を作るよう指示を強める(10問時代の「テキストの各部分を幅広くカバー」という指示は削除し、代わりに「最も重要な概念を1つ選び、それを理解しているか判定できる問題」とする)
- `src/lib/llm/schemas.ts` — `QuizGenerationSchema` の `z.array(...).length(10)` を削除。`QuizQuestionSchema` 単体を生成結果スキーマとして使う
- `src/lib/constants.ts` — `QUIZ_QUESTIONS_PER_SET = 10` を削除。`LLM_QUIZ_MAX_TOKENS` は 2000 → 512 に縮小(1問なら十分。レイテンシとコストが下がる)
- `src/lib/llm/quiz.ts` — `generateQuizQuestions()` → `generateQuestion(sourceText): Promise<QuizQuestion | null>`。`parseWithRetry` (`src/lib/llm/parser.ts`) と `callGemini` (`src/lib/llm/client.ts`) はそのまま再利用、変更不要

---

## 3. リポジトリ層

`src/lib/db/repository/quiz-repository.ts` を削除し `question-repository.ts` を新設。

| 関数                                                         | 役割                                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `createKnowledgeWithQuestion({title, sourceText, question})` | トランザクションで knowledge + questions を1件ずつ insert。既存 `createQuizSet` の transaction パターンをそのまま踏襲 |
| `getQuestionById(id)`                                        | 採点用。correctIndex/explanation を含む                                                                               |
| `pickWeightedRandomQuestion(excludeIds)`                     | **苦手優先ランダム選出**(下記)                                                                                        |
| `recordAnswer({questionId, selectedIndex, isCorrect})`       | answerLogs に1行 insert                                                                                               |
| `getStats()`                                                 | 総問題数・総解答数・累計正答率。ホーム画面用                                                                          |

### 苦手優先ランダムのアルゴリズム

問題ごとの集計(総解答数 / 誤答数 / 直近解答の正誤)を1クエリで取得し、アプリ側で重みを計算して重み付き抽選する。

```
未回答            → weight = 5
回答済            → weight = 1 + 4 * (誤答数 / 総解答数)
直近の解答が不正解 → weight += 2
excludeIds に含まれる問題は候補から除外
　※ 除外して候補が0件になったら除外を無視して全件から抽選(問題数が少ない初期状態での詰まり回避)
```

`excludeIds` はクライアントが「今回のセッションで直近に出た問題ID」(直近10件程度)を送る。これにより同じ問題の連続出題を防ぐ。

**スケール上の注記**: 全問題を1度に取得してアプリ側で抽選するため、問題数が数千件規模になったら SQL 側での抽選に切り替えが必要。プロトタイプ規模では問題ない旨をコードコメントに残す。

---

## 4. API

`src/app/api/quiz-sets/` を丸ごと削除し、以下に置き換える。

| エンドポイント                            | 内容                                                                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/questions`                     | `{ sourceText }` → 1問生成して保存 → `{ id, question, choices, correctIndex, explanation }` を返す。作成画面でそのままプレビュー表示するため正解も返す。`maxDuration = 300` は維持 |
| `GET /api/questions/random?exclude=1,2,3` | 苦手優先ランダムで1問。**`correctIndex` と `explanation` は返さない** (`{ id, question, choices }` のみ)。問題が0件なら 404                                                        |
| `POST /api/answers`                       | `{ questionId, selectedIndex }` → **サーバー側で正誤判定**し answerLogs に記録 → `{ isCorrect, correctIndex, explanation }` を返す                                                 |
| `GET /api/stats`                          | ホーム表示用の集計                                                                                                                                                                 |

**判定をサーバー側に置く理由**: 出題レスポンスに正解を含めないことでクライアントからのカンニングを防ぎ、同時に解答履歴の記録を1往復にまとめられる。

### 選択肢シャッフル

サーバーはDB格納順のまま `choices` を返し、シャッフルは**クライアント**で行う。`POST /api/answers` に送る `selectedIndex` は、シャッフル前の元インデックスに戻してから送る。

`src/lib/shuffle.ts` の `fisherYatesShuffle` はそのまま再利用。10問向けの `shuffleQuestionsAndChoices` は削除し、1問向けの `shuffleChoices(choices): { choices, choiceIndices }` に置き換える(`choiceIndices[shuffled] = original` のマッピングを返し、クライアントが逆引きに使う)。

---

## 5. 画面構成

`src/app/quiz/[id]/` (page.tsx / QuizRunner.tsx / styles.module.css) を削除。

### `/` — ホーム (`src/app/page.tsx` を全面書き換え)

現在の「テキストエリア + 生成ボタン + 過去セット一覧」を廃止し、2つの大きなアクションに絞る。

- 「**問題を作る**」→ `/create`
- 「**問題を解く**」→ `/answer` (問題が0件なら disabled にして「まず問題を作ってください」と表示)
- 下部に軽い統計 (総問題数 / 累計正答率)

サーバーコンポーネントにして `getStats()` を直接呼ぶ。現在の `useEffect` + `fetch` によるクライアント取得は不要になる。

### `/create` — 作成専用 (新規)

1. ナレッジ本文の textarea + 「この内容から1問作る」ボタン
2. 生成中はローディング表示 (LLM 待ちは数秒〜数十秒かかるため、進行中であることが明確に分かる表示にする)
3. 生成完了 → **作成された問題をプレビュー表示** (問題文・4択・正解・解説)
4. プレビュー下に「続けてもう1問作る」(フォームをクリアして再入力) / 「問題を解きに行く」(`/answer`) / 「ホームへ」

作成フローは解答へ自動遷移しない。これが要件3の「作成のみで独立させる」の核。

### `/answer` — 解答専用・エンドレス (新規)

クライアントコンポーネント。状態機械は `loading → question → feedback → (next) → loading ...`。

1. マウント時に `GET /api/questions/random` で1問取得、クライアントで選択肢シャッフル
2. 問題文 + 4択を表示。選択肢タップで即 `POST /api/answers`
3. **即フィードバック**: 選んだ選択肢を正誤で色付け、不正解なら正解を強調、解説を表示
4. 「次の問題へ」ボタン → セッション内の出題済みID(直近10件)を `exclude` に付けて再取得 → 1に戻る
5. 画面上部にセッション成績 (`3/5 正解`) を常時表示
6. 「やめる」でホームへ

ユーザーが「次の問題へ」を押し続ける限り無限に続く。まとめ採点画面は存在しない。

---

## 6. モバイル最適化 (Tailwind v4)

### 導入

- `tailwindcss` v4 + `@tailwindcss/postcss` を devDependencies に追加。既存の `postcss` 8.5.16 はそのまま利用
- `postcss.config.mjs` を新規作成 (`@tailwindcss/postcss` プラグインのみ)
- `src/app/globals.css` を `@import "tailwindcss";` + `@theme` によるトークン定義に置換。現在の `:root` CSS 変数(色・スペーシング)は `@theme` に移植し、ダークモードは `prefers-color-scheme` ベースを維持
- `src/app/page.module.css` と `src/app/quiz/[id]/styles.module.css` を削除

### 適用する具体パターン

| 項目             | 対応                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| viewport         | `layout.tsx` に `export const viewport` を追加し `viewportFit: "cover"` を指定 (Next.js のデフォルトには含まれないため明示が必要) |
| 画面高           | `100vh` ではなく `min-h-dvh`。モバイルブラウザの URL バー伸縮でレイアウトが崩れるのを防ぐ                                         |
| safe-area        | 下部固定要素に `pb-[env(safe-area-inset-bottom)]`                                                                                 |
| タッチターゲット | 選択肢ボタン `min-h-14` (56px)、主要アクション `min-h-12` (48px)。現在の `padding: 0.75rem 1.5rem` は指ではタップしづらい         |
| 入力ズーム防止   | textarea を含む入力要素は `text-base` (16px) 以上。iOS Safari が 16px 未満でオートズームするため                                  |
| コンテナ         | `globals.css` の `max-width:900px` 固定をやめ、`w-full max-w-2xl mx-auto px-4` に。狭幅では余白を詰める                           |
| アクション配置   | `/answer` の「次の問題へ」は画面下部に `sticky bottom-0` で固定。長い問題文・解説をスクロールしても親指の届く位置に留まる         |
| 選択肢レイアウト | 現在の `flex` 横並び(A/B/C/D バッジ + テキスト)は維持しつつ `items-start` + `break-words` で長文折り返しを保証                    |
| 廃止             | 10問インジケータ (`QuizRunner.tsx:134-146`) は1問ずつの出題になるため不要。狭幅で最も破綻していた箇所                             |

---

## 7. 仕様書更新

`AGENTS.md` のルールに従い `openspec/specs/study/spec.md` を実装と同時に全面改訂する。

- Overview: 「10問クイズセット」→「1ナレッジ1問 + ランダム出題ループ」
- Data Model: `knowledge` / `questions`(1:1) / `answerLogs`
- Requirements R1〜R7 を新フローで書き直し (作成と解答の分離、即フィードバック、苦手優先ランダム、解答履歴の永続化)
- API Specification: 新4エンドポイント
- Components: `/create`, `/answer` の新コンポーネント
- Non-Functional: モバイル最適化の具体基準 (タッチターゲット48px以上、safe-area対応、dvh)

---

## 8. テスト更新

| ファイル                    | 対応                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/llm/schemas.test.ts` | 「10問でないと失敗する」テスト(`:37-47`)を削除。単一問題スキーマのテストに置き換え                                                                                                                       |
| `tests/shuffle.test.ts`     | `shuffleQuestionsAndChoices` 前提のケースを `shuffleChoices` に更新。`choiceIndices` の逆引きが正しいことを検証                                                                                          |
| `tests/e2e/home.spec.ts`    | ホームが textarea ではなく2つのアクションを持つ形に変更されたため書き換え                                                                                                                                |
| `playwright.config.ts`      | `projects` に `devices["Pixel 5"]` を追加し、モバイルビューポートでも e2e を回す                                                                                                                         |
| 新規 e2e                    | 作成フロー(ナレッジ投入→1問プレビュー→自動遷移しないこと)と解答フロー(出題→選択→即フィードバック→次の問題)。LLM 呼び出しはコストがかかるため、作成 API はモックするかテスト用の短いナレッジで1回だけ実行 |

---

## 実装順序

1. スキーマ + 型 (`src/lib/db/schema.ts`, `src/types/quiz.ts`) → `pnpm db:push`
2. LLM 層を1問生成に (`prompts.ts`, `schemas.ts`, `quiz.ts`, `constants.ts`)
3. リポジトリ層 (`question-repository.ts` 新設、`quiz-repository.ts` 削除)
4. API 4本 (`api/questions`, `api/questions/random`, `api/answers`, `api/stats`)、`api/quiz-sets` 削除
5. Tailwind v4 導入 + `globals.css` 置換 + CSS Modules 削除
6. 画面 3本 (`/`, `/create`, `/answer`)、`/quiz/[id]` 削除
7. `shuffle.ts` を1問向けに整理
8. テスト更新 + 仕様書更新

---

## 検証

```bash
pnpm type-check      # 削除したモジュールへの参照が残っていないことを確認
pnpm lint
pnpm test            # vitest (schemas, shuffle)
pnpm db:push         # 新スキーマ適用
pnpm dev
pnpm test:e2e        # chromium + Pixel 5 の両プロジェクト
```

### 手動確認 (要件との対応)

1. **要件1**: `/create` にナレッジを投入 → 生成結果が **1問だけ** であること。DB を `pnpm db:studio` で開き、knowledge 1行に対し questions が1行のみであることを確認
2. **要件3(作成の独立)**: 作成完了後、解答画面に**自動遷移しない**こと。プレビューが表示され、次のアクションをユーザーが選べること
3. **要件3(ランダム出題)**: ナレッジを5件ほど作成 → `/answer` で連続出題し、作成順ではなくランダムに出ること。同じ問題が連続して出ないこと
4. **要件2(サイクル)**: 選択肢をタップした瞬間に正誤と解説が出ること。「次の問題へ」で次の問題に進み、まとめ採点画面が出ないこと
5. **苦手優先**: ある問題をわざと複数回間違える → その後の出題でその問題が相対的に多く出ること (`answer_logs` を db:studio で確認しつつ)
6. **要件4(モバイル)**: Chrome DevTools の iPhone SE (375px) / Pixel 5 でホーム・作成・解答の3画面を確認。横スクロールが発生しないこと、選択肢と主要ボタンが親指で押せるサイズ(48px以上)であること、`/answer` の「次の問題へ」が長い解説をスクロールしても下部に留まること、textarea 選択時に画面がズームしないこと

---

## 進捗

**完了日**: 2026-08-04
**コミット**: `5ff5dda` — feat: Study app redesign - 1-knowledge-1-question endless learning model

### 実装フェーズ

| #   | フェーズ                                                             | 担当             | 状態    | 検証                                                               |
| --- | -------------------------------------------------------------------- | ---------------- | ------- | ------------------------------------------------------------------ |
| 1   | バックエンド全面入れ替え (schema/types/constants/LLM/API/repository) | @fixer           | ✅ 完了 | type-check:fast exit0 / lint:fast exit0 / test exit0(5ケース)      |
| 1r  | Oracleレビュー → remediation (S2/S3 5件修正)                         | @oracle → @fixer | ✅ 完了 | exit0                                                              |
| 2   | Tailwind v4 + 画面3本 (/ /create /answer)                            | @designer        | ✅ 完了 | type-check:fast exit0 / lint:fast exit0 / test exit0 / build exit0 |
| 2r  | Oracleレビュー → remediation (UI S2/S3 + lint warning)               | @oracle → @fixer | ✅ 完了 | exit0                                                              |
| 3.1 | E2Eテスト作成 (home/create/answer)                                   | @fixer           | ✅ 完了 | test exit0 / build exit0                                           |
| 3.2 | Playwright Pixel 5追加                                               | @fixer           | ✅ 完了 | -                                                                  |
| 3.3 | spec.md全面改訂                                                      | @fixer           | ✅ 完了 | -                                                                  |
| 3.4 | 最終検証                                                             | -                | ✅ 完了 | type-check/lint/test/build 全exit0                                 |
| 3r  | Oracleレビュー(最終)                                                 | @oracle          | ✅ 承認 | S1なし                                                             |

### 変更ファイル一覧

**削除** (旧10問モデル):

- `src/app/api/quiz-sets/route.ts`
- `src/app/api/quiz-sets/[id]/route.ts`
- `src/app/quiz/[id]/page.tsx`, `QuizRunner.tsx`, `styles.module.css`
- `src/app/page.module.css`
- `src/lib/db/repository/quiz-repository.ts`

**新規** (1問エンドレスモデル):

- `src/app/api/questions/route.ts` — POST 1問生成
- `src/app/api/questions/random/route.ts` — GET 苦手優先ランダム
- `src/app/api/answers/route.ts` — POST 正誤判定+記録
- `src/app/api/stats/route.ts` — GET 統計
- `src/app/create/page.tsx` — 作成画面
- `src/app/answer/page.tsx` — 解答画面(エンドレス)
- `src/lib/db/repository/question-repository.ts` — リポジトリ層
- `tests/e2e/create.spec.ts`, `tests/e2e/answer.spec.ts`

**更新**:

- `src/lib/db/schema.ts` — knowledge/questions/answerLogs
- `src/types/quiz.ts` — Knowledge/Question/AnswerLog/QuestionForAnswering
- `src/lib/llm/prompts.ts` — 1問生成プロンプト
- `src/lib/llm/quiz.ts` — generateQuestion()
- `src/lib/shuffle.ts` — shuffleChoices() (1問向け)
- `src/app/page.tsx` — ホーム(統計+2導線)
- `src/app/globals.css` — Tailwind v4
- `openspec/specs/study/spec.md` — 全面改訂
- `playwright.config.ts` — Pixel 5追加
