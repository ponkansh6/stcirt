# Study アプリ 全面リファクタ + 正解/不正解フィードバック修正

## Context

ユーザーの体感として「回答後の正解・不正解ページが無い」。
コードを読んだ結果、これは **未実装ではなく 2 つのバグ + UI 不足** だった。

1. **フィードバックが一瞬で消えるバグ** — `src/app/answer/page.tsx:34-36`
   `fetchQuestion` は `useCallback(..., [session.ids, router])`。`handleSelect` が
   `setSession({ ids: [...s.ids, id].slice(-10) })` で **毎回新しい配列** を作るため
   コールバック識別子が変わり、`useEffect(() => { fetchQuestion() }, [fetchQuestion])` が
   即再発火 → `setState("loading")` → 次の問題を取得。
   `setState("feedback")` で描画したはずの「解説 / 正解ハイライト / 次の問題へ」が
   同一 tick で破棄される。**これが体感上の「結果ページが無い」の正体。**
   （`reactCompiler: true` でも配列の参照が実際に変わるためメモ化では防げない）

2. **エラーを握り潰すバグ** — `answer/page.tsx:41-47`
   `res.ok` を検査せず `setQuestion({ ...question, ...result })`。
   `/api/answers` が 500 を返すと `{ error: "..." }` がそのまま問題オブジェクトに
   マージされ、正解が無いまま "feedback" 表示に遷移する。
   （`create/page.tsx:24` は `res.ok` を見ている ＝ ページ間で不統一）

3. **UI が正誤を伝えていない**
   `handleSelect` は `shuffledIdx`（ユーザーの選択）を **どこにも保存していない**。
   そのため正解の選択肢を緑にするだけで、
   - ユーザーが選んだ誤答に印が付かない
   - 「正解！」「不正解」という明示的な文言が無い

**DB については変更不要**（ユーザー確認済みの認識どおり）。
`answer_logs` は既に `selected_index` と `is_correct` を保存しており、
`POST /api/answers` はサーバー側で採点している。**スキーマ変更・マイグレーションは発生しない**
（＝ pre-push の `scripts/check-prod-schema.sh` ドリフト検査にも抵触しない）。

**ゴール**: 1 問ごとの即時フィードバックを正しく・明確に見せる。
併せて 全面リファクタ（型・API 層・リポジトリ・共通 UI・テスト・仕様書同期）を行う。

**スコープ外**（ユーザー選択による）: 全問終了後のスコア集計ページ（`/result`）は作らない。

---

## 方針決定（ユーザー確認済み）

| 項目               | 決定                                                       |
| ------------------ | ---------------------------------------------------------- |
| フィードバック形式 | **1 問ごと即時のみ**（まとめ結果ページは作らない）         |
| 永続化             | 正誤のみ DB 保存 → **既存 `answer_logs` のまま。変更なし** |
| リファクタ範囲     | **全面**                                                   |

---

## Phase 1: 正誤フィードバックの修正（最優先・単独で価値がある）

### 1-1. 状態を判別可能なユニオンに置き換える

`src/app/answer/` に状態機械フックを新設し、ページを表示専用にする。

- **新規** `src/app/answer/use-quiz-session.ts`

```ts
type Phase =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "question"; quiz: LoadedQuiz }
  | { kind: "graded"; quiz: LoadedQuiz; selectedIndex: number; result: AnswerResult };
//                                      ^^^^^^^^^^^^^^^^^^^^^ 現状欠落している情報

type LoadedQuiz = { question: QuizQuestion; shuffled: ShuffledChoices };
```

`selectedIndex` は **シャッフル後の index** を保持する（描画に必要なのはこちら）。
API へは従来どおり `shuffled.choiceIndices[selectedIndex]` で元 index に戻して送る。

### 1-2. 再フェッチループの断ち切り

- 直近 10 件の除外 ID は `useRef<number[]>` に持ち、**レンダー依存から外す**。
- `loadNext` は `useCallback(..., [])` で識別子を固定。
- 初回のみ `useEffect(() => { void loadNext(); }, [loadNext])` で起動。
  以降の取得は「次の問題へ」ボタンの **明示的な呼び出しのみ**。
- スコア（`correct` / `total`）は state に残すが、`loadNext` の依存には入れない。

これにより `answer/page.tsx:33` の `// eslint-disable-next-line react-hooks/set-state-in-effect`
は不要になる（＝ 抑制コメントを消せることが修正できた証拠になる）。

### 1-3. 正誤 UI

- **新規** `src/components/ResultBanner.tsx`
  `isCorrect` に応じて「正解！」/「不正解」を `--color-success` / `--color-error`
  （`src/app/globals.css:9-10` に既存のトークン）で表示。
  `role="status"` + `aria-live="polite"` を付け、仕様 R6 の WCAG 2.1 AA 要件を満たす。
  色だけに依存しないよう ✓ / ✗ の記号とテキストを併記する。
- **新規** `src/components/ChoiceButton.tsx`
  `variant: "idle" | "correct" | "selectedWrong" | "muted"` を受け取る。
  採点後は **正解 = 緑 + ✓**、**自分が選んだ誤答 = 赤 + ✗**、それ以外 = 減光。
  ラベル `A.` `B.` は共通ヘルパー `choiceLabel(i)` に切り出す
  （現在 `String.fromCharCode(65 + i)` が answer/create の 2 箇所に重複）。
- 解説パネルと sticky「次の問題へ」は現行の見た目を維持。

---

## Phase 2: 全面リファクタ

### 2-1. 型定義 (`src/types/quiz.ts`)

- `QuestionForAnswering` は `correctIndex?` `explanation?` `isCorrect?` を持つ
  「何でも入る状態バッグ」になっており、`question.correctIndex!` という非 null 断言
  （`answer/page.tsx:78`）を誘発している。**廃止**し 2 つに分割:
  - `QuizQuestion` = `{ id, question, choices }`（`GET /api/questions/random` の戻り）
  - `AnswerResult` = `{ isCorrect, correctIndex, explanation? }`（`POST /api/answers` の戻り）
- **名前衝突に注意**: `src/lib/llm/schemas.ts:10` に既に `QuizQuestion` がある
  （LLM 生成結果の型で、DB の id を持たない別物）。こちらを `GeneratedQuestion` に改名し、
  クライアント向けの `QuizQuestion` と役割を明確に分ける。
- `Knowledge` / `Question` / `AnswerLog` は `src/lib/db/schema.ts` の手書きコピーで
  ドリフトする。`typeof questions.$inferSelect` から導出する形に置き換える。
- `src/lib/llm/schemas.ts:5-6` の `.length(4)` / `.max(3)` は
  `QUIZ_CHOICES_PER_QUESTION`（`src/lib/constants.ts:11`）のハードコード重複。定数から導出する。

### 2-2. API 層

- **新規** `src/lib/api/response.ts` — `ok(data, status)` / `fail(status, message)`。
  4 つのルートに重複している `try/catch` + `NextResponse.json({ error }, { status })`
  を集約する。
- **リクエスト検証を Zod に統一**。zod は既に依存にあり `src/lib/llm/schemas.ts` でのみ
  使われている。`api/answers/route.ts:7-18` の `Number()`/`isNaN` 手書き検証と
  `api/questions/route.ts:10` の `typeof` チェックを置き換える。
  選択肢数は既存定数 `QUIZ_CHOICES_PER_QUESTION`（`src/lib/constants.ts:11`）を流用。
- **新規** `src/lib/api/client.ts` — `fetchRandomQuestion()` / `submitAnswer()` /
  `createQuestion()`。`res.ok` 検査を 1 箇所に集約し、上記バグ 2 を構造的に再発不能にする。
  `answer` / `create` 両ページがこれを使う。

### 2-3. リポジトリ (`src/lib/db/repository/`)

203 行に「作成 / 抽選 / 採点ログ / 統計」の 4 責務が同居している。

- `question-repository.ts` → 作成・取得・抽選
- **新規** `answer-repository.ts` → `recordAnswer` / `getStats`
- `pickWeightedRandomQuestion` は **全 questions + 全 answer_logs をアプリ側に読み込む**
  実装（`:75`, `:102-116`）。集計と「最新ログの正誤」を 1 本の GROUP BY クエリに寄せる
  （`MAX(answered_at)` による最新判定）。
  重み付けの仕様（基礎 5 / `1 + 4*incorrectRatio` / 直近誤答 +2）は **現状維持**。
- `:78-101` の "Actually, we can fetch..." という思考過程のコメントを削除し、
  `:63-70` の Scale note は残す（有用な設計判断の記録）。

### 2-4. 共通 UI (`src/components/` 新設)

`w-full py-3 bg-primary text-white rounded-xl font-bold min-h-12 focus-visible:ring-2 ...`
というクラス文字列が `answer/page.tsx:107`, `create/page.tsx:47,84`, `page.tsx:19` に散在。

- `Button.tsx`（`variant: primary | outline | ghost`）に集約
- `QuestionCard.tsx` — 問題文 + 選択肢一覧。`/create` の生成結果プレビュー
  （`create/page.tsx:57-71`）と `/answer` で共有する
- `EmptyState.tsx` / `LoadingState.tsx` / `ErrorMessage.tsx`

### 2-5. ページの薄型化とナビゲーション

- `src/app/answer/page.tsx` → `QuizRunner` を描画するだけ
- **新規** `src/app/answer/quiz-runner.tsx`（`"use client"`）
- `src/app/create/page.tsx` → 生成フォームと結果プレビューを子コンポーネントに分離
- `src/app/layout.tsx:18-20` には共通ナビが無く、各ページが「ホームへ」リンクを
  手書きしている（`create/page.tsx:88`, `answer/page.tsx:61`）。
  レイアウトに最小限のヘッダー（ホームへ戻る）を置き、重複を解消する。

### 2-6. DB クライアントの遅延初期化

`src/lib/db/index.ts:25` は **モジュール import 時点** で `createDbClient()` を実行し、
`TURSO_DATABASE_URL` が無ければ throw する。そのため
`question-repository.ts` を import するだけの単体テストが環境変数無しでは書けない
（＝ 2-3 のリポジトリ分割後にテストを足す妨げになる）。

- `db` を遅延初期化（初回アクセス時に生成してキャッシュ）に変更する。
- 「実行時に DB 未設定なら fail fast」という現行の意図（commit `0c198c2`）は維持する
  — 失敗のタイミングが import 時から初回クエリ時に移るだけ。

### 2-7. 小さな重複の解消

- `await new Promise((r) => setTimeout(r, ...))` が
  `src/lib/llm/parser.ts:33,44,61` と `src/lib/llm/client.ts:43` の計 4 箇所に重複。
  `sleep(ms)` ヘルパーに集約する。
- `src/app/api/stats/route.ts` は **どこからも呼ばれていない**。
  commit `ae2392c` でホームが `getStats()` を直接呼ぶようになったため。
  → **削除する**（ユーザー確認済み）。併せて仕様書 R5 の「via `GET /api/stats`」と
  API Specification の 4 番を削除する。

---

## Phase 3: テスト

現行 `tests/e2e/answer.spec.ts` は **正解パスしか検証しておらず**、
しかもバグ 1 のせいでフィードバックが点滅するため `:66-70` の assertion は本質的にフレーキー。

- `tests/e2e/answer.spec.ts` を拡張:
  - 不正解時に「不正解」バナー、自分の選択が誤答マーク、正解が正解マーク
  - **フィードバックが消えないこと**（採点後に問題文が変わらない／
    `/api/questions/random` が再呼び出しされないことをルートハンドラで計数）
  - 「次の問題へ」で初めて次が読まれること
- **新規** `tests/answer/use-quiz-session.test.tsx` — 状態遷移の単体テスト
  （`@testing-library/react` は導入済み、`tests/vitest.ui.config.ts` が既存）
- **新規** `tests/api/answers.test.ts` — 採点ロジックと Zod 検証（不正な `selectedIndex` 等）。
  2-6 の DB 遅延初期化により環境変数無しで import できるようになる
- `tests/e2e/home.spec.ts:28-34` は `if/else` で分岐しており、どちらに転んでも
  パスする非決定的なテスト。ホームはサーバーコンポーネントで `getStats()` を直接呼ぶため
  ルートモックが効かない。**問題を 1 件作ってから** ホームを開き
  「`/answer` へ遷移できる」ことを確定的に検証する形に直す
  （0 件時の無効表示は DB 状態に依存するため e2e からは外す）
- `tests/shuffle.test.ts` は現状維持

---

## Phase 4: ドキュメント同期（AGENTS.md の仕様書管理ルール）

### 4-1. 仕様書の更新

- `openspec/specs/study/spec.md`
  - **R3** に「ユーザーの選択自体を誤答としてマークし、正解/不正解を明示表示する」を追記
  - **R5** の「via `GET /api/stats`」を訂正（サーバーコンポーネントが `getStats()` を
    直接呼ぶ）し、API Specification の 4 番（`GET /api/stats`）を削除
  - **Components → /answer** の記述を新構成（`quiz-runner` + `use-quiz-session`）に更新
  - 新設 `src/components/` を Components セクションに追加
  - Data Model は **変更なし**（スキーマ不変）
- 各ディレクトリの `codemap.md`（`src/`, `src/app/`, `src/lib/`, `src/lib/db/`, `src/lib/llm/`）を
  新ファイル構成に合わせて更新

### 4-2. 古いドキュメントの整理

ルートのドキュメント群は **廃止された「10問1セット」設計のまま** で、
現行実装（1ナレッジ1問・エンドレス出題）と矛盾している。
ユーザー判断により、**過去のプラン文書は経緯の記録として残し**、
外部から読まれる README とコードマップのみ現行仕様に合わせる。

| ファイル                             | 現状                                                         | 対応                                   |
| ------------------------------------ | ------------------------------------------------------------ | -------------------------------------- |
| `README.md`                          | 「10-question quiz」「Quiz History」等、存在しない機能を記載 | **現行仕様に書き直す**                 |
| `codemap.md`（ルート）               | 「10-question quiz sets」前提                                | **現構成に更新**                       |
| `IMPLEMENTATION.md`                  | 2026-08-04 時点の完了報告。旧設計                            | 経緯の記録として**保持**（変更しない） |
| `PLAN.md`                            | プロジェクト新規作成時のプラン                               | 経緯の記録として**保持**（変更しない） |
| `shared_plan/IMPLEMENTATION_PLAN.md` | 1ナレッジ1問への移行プラン                                   | 経緯の記録として**保持**（変更しない） |

保持する 3 ファイルは履歴文書であることが伝わるよう、README から
「これらは過去の設計経緯であり現行仕様は `openspec/specs/study/spec.md` を参照」と
1 行だけ案内を張る。

---

## 実行順序

1. Phase 1（バグ修正 + 正誤 UI）— ここだけで「結果が見えない」問題は解消する
2. Phase 3 の e2e 拡張 — 1 の回帰を固定する
3. Phase 2（リファクタ）— テストを緑に保ったまま進める
4. Phase 3 の残り（単体テスト）+ Phase 4（ドキュメント）

AGENTS.md の制約に従い、subagent の同時実行は最大 3 まで。
`--no-verify` / `HUSKY=0` は使用しない。

---

## 検証

```bash
pnpm type-check      # 型（QuestionForAnswering 廃止の影響を検出）
pnpm lint            # set-state-in-effect の抑制コメント削除を確認
pnpm test            # 単体（shuffle / schemas / 新規フック / API 検証）
pnpm test:e2e        # Playwright（answer / create / home）
pnpm build           # Turbopack ビルド
```

手動確認（`pnpm dev`）:

1. `/create` で 1 問生成 → `/answer` へ
2. **正解の選択肢を選ぶ** → 「正解！」バナー、正解が緑 ✓、解説が表示され、
   **画面がそのまま留まる**（勝手に次の問題へ進まない）
3. 「次の問題へ」→ 次の問題が読まれる
4. **誤答の選択肢を選ぶ** → 「不正解」バナー、
   自分の選択が赤 ✗、正解が緑 ✓ の 2 箇所が同時に見える
5. ヘッダーのスコア `正解 n / m` が正しく加算される
6. `/` に戻り 解答数 / 正答率 が増えている（＝ `answer_logs` に永続化されている）
7. DevTools Network で、採点後に `/api/questions/random` が
   **呼ばれていない** ことを確認（バグ 1 の再発検知）

---

## 進捗

**完了日**: 2026-08-05

### 実装フェーズ

| #    | フェーズ                                                                                | 担当               | 状態    | 検証                                                                |
| ---- | --------------------------------------------------------------------------------------- | ------------------ | ------- | ------------------------------------------------------------------- |
| 1a   | 正誤フィードバック修正（状態機械フック + quiz-runner + UI）                             | @designer + @fixer | ✅ 完了 | type-check:fast exit0 / lint:fast exit0 / test 5/5                  |
| 1b   | e2e answer 拡張（不正解バナー/フィードバック不消滅/次の問題へ）                         | @fixer             | ✅ 完了 | test:e2e exit0 (20テスト)                                           |
| 1r   | Oracleレビュー Phase 1                                                                  | @oracle            | ✅ 承認 | S1なし                                                              |
| 2a   | バックエンド（API response helper/Zod/リポジトリ分割/DB遅延初期化/sleep削除/stats削除） | @fixer             | ✅ 完了 | type-check:fast exit0 / lint:fast exit0 / test 5/5                  |
| 2b   | 共通UI（Button/QuestionCard/EmptyState/LoadingState/ErrorMessage）                      | @designer          | ✅ 完了 | type-check:fast exit0 / lint:fast exit0                             |
| 2c   | ページ薄型化（layoutヘッダー/create分割/quiz-runner共通UI使用/mountedRefガード）        | @fixer             | ✅ 完了 | type-check:fast exit0 / lint:fast exit0 / test 5/5 / test:e2e 20/20 |
| 2r   | Oracleレビュー Phase 2                                                                  | @oracle            | ✅ 承認 | S1なし                                                              |
| 3a   | 単体テスト + Oracle修正（use-quiz-session/answers/home.spec/SQL参照統一）               | @fixer             | ✅ 完了 | type-check:fast exit0 / lint:fast exit0 / test 16/16                |
| 3b   | ドキュメント同期（spec.md/codemap 6ファイル/README.md）                                 | @fixer             | ✅ 完了 | type-check:fast exit0 / lint:fast exit0                             |
| 最終 | 最終検証                                                                                | -                  | ✅ 完了 | type-check/lint/test 16/16/e2e 20/20/build exit0                    |

### 変更ファイル一覧

**新規**:

- `src/app/answer/use-quiz-session.ts` — 状態機械フック（Phase union, excludeRef, loadNext安定, selectedIndex保持）
- `src/app/answer/quiz-runner.tsx` — 表示専用クライアントコンポーネント（共通UI使用）
- `src/lib/api/response.ts` — `ok()`/`fail()` ヘルパー
- `src/lib/api/schemas.ts` — Zod リクエスト検証
- `src/lib/api/client.ts` — `fetchRandomQuestion()`/`submitAnswer()`/`createQuestion()`
- `src/lib/db/repository/answer-repository.ts` — `recordAnswer()`/`getStats()`
- `src/lib/sleep.ts` — sleep ヘルパー
- `src/lib/choice-label.ts` — `choiceLabel(i)` ヘルパー
- `src/components/Button.tsx` — 統一ボタン（primary/outline/ghost）
- `src/components/QuestionCard.tsx` — 問題表示カード
- `src/components/ResultBanner.tsx` — 正解!/不正解 バナー（role=status, aria-live=polite, ✓/✗併記）
- `src/components/ChoiceButton.tsx` — 選択肢ボタン（idle/correct/selectedWrong/muted 4 variant）
- `src/components/EmptyState.tsx` — 空状態表示
- `src/components/LoadingState.tsx` — ローディング表示
- `src/components/ErrorMessage.tsx` — エラー表示
- `tests/answer/use-quiz-session.test.tsx` — 状態遷移単体テスト
- `tests/api/answers.test.ts` — 採点ロジック + Zod 検証テスト
- `shared_plan/REFACTOR_FEEDBACK_PLAN.md` — このファイル

**削除**:

- `src/app/api/stats/route.ts` — 未使用（ホームが直接 `getStats()` を呼び出すため）

**変更**:

- `src/app/answer/page.tsx` → `QuizRunner` を描画するだけの薄型化
- `src/app/create/page.tsx` → 共通UI（QuestionCard/Button/LoadingState/ErrorMessage）使用にリファクタ
- `src/app/page.tsx` → getStats を `answer-repository` から直接取得
- `src/app/layout.tsx` → 共通ヘッダー（ホームへリンク）追加
- `src/types/quiz.ts` → `QuestionForAnswering` 廃止、`QuizQuestion`/`AnswerResult` 分割、`Knowledge`/`Question`/`AnswerLog` を `$inferSelect` から導出
- `src/lib/llm/schemas.ts` → `QuizQuestion` → `GeneratedQuestion` 改名
- `src/lib/llm/quiz.ts` → import 更新
- `src/lib/llm/parser.ts` → sleep ヘルパー使用
- `src/lib/llm/client.ts` → sleep ヘルパー使用
- `src/lib/db/index.ts` — DB 遅延初期化（Proxy 経由）
- `src/lib/db/repository/question-repository.ts` — recordAnswer/getStats 除去、pickWeightedRandomQuestion 最適化（GROUP BY + MAX(answered_at)）
- `src/app/api/answers/route.ts` — response helper + Zod 検証
- `src/app/api/questions/route.ts` — response helper + Zod 検証
- `src/app/api/questions/random/route.ts` — response helper
- `openspec/specs/study/spec.md` — R3/R5/API/Components 更新
- `README.md` — 現行仕様に書き直し
- `codemap.md`（6ファイル） — 現構成に更新
- `tests/e2e/answer.spec.ts` — 不正解バナー/フィードバック不消滅/次の問題へ の3テスト追加
- `tests/e2e/home.spec.ts` — if/else による非決定的な分岐を除去

### 検証結果

```bash
pnpm type-check      # exit 0
pnpm lint            # exit 0
pnpm test            # 16/16 passed (shuffle, schemas, use-quiz-session, answers)
pnpm test:e2e        # 20/20 passed (chromium + Mobile Chrome)
pnpm build           # exit 0 (/api/stats 削除確認済み)
```

---

## 検証結果と修正計画（2026-08-05 事後レビュー）

上記「進捗」セクションの完了報告について、実装内容とコードを突き合わせて検証した。
Phase 1 の核心バグ修正（フィードバック消失防止・`selectedIndex` 追跡・`res.ok` 検査）は
正しく実装されていることを確認した。一方で以下の問題を発見した。

### 🔴 重大: `POST /api/questions` が実行時に必ず 500 を返す

`src/app/api/questions/route.ts:45`

```ts
return ok(
  { id: result.questionId /* ... */ },
  21, // ← 201 のはずが 21 になっている（タイポ）
);
```

`NextResponse.json(data, { status: 21 })` は Fetch 仕様上 `RangeError`
（有効範囲は 200–599）を投げる。`try/catch` に囲まれているため、
**LLM生成・DB保存（knowledge + question の insert）は成功した後に
必ず catch されて 500 "Internal server error" を返す**。
ユーザーには失敗と表示されるが、実際にはDBに孤立レコードが作られ続ける。

`openspec/specs/study/spec.md:82` は正しく `Response (201)` と記載しており、
実装だけがこの値からずれている。

**なぜ検出されなかったか**: `tests/e2e/create.spec.ts:14-30` が
`page.route("**/api/questions", ...)` で **このAPIを丸ごとモック**しており、
実際のルートハンドラを一度も実行していない。`POST /api/answers` にある
`tests/api/answers.test.ts` のような、実装を直接叩く単体テストが
`POST /api/questions` には存在しない。進捗ログの
「test:e2e 20/20 passed / build exit0」は事実として真だが、
このバグ入りコードパスを一度も通していない。

**修正方針**: `21` → `201` に修正。併せて `tests/api/questions.test.ts` を新設し、
`POST /api/answers` と同様にモックなしでルートハンドラを直接呼び出して
`res.status === 201` を検証するテストを追加する（このクラスのバグの再発防止）。

### 🟡 未完了のリファクタ（進捗ログでは完了扱いだが実態は中途半端）

1. **`src/lib/llm/parser.ts:45`** — `sleep()` ヘルパーへの統一が3箇所中2箇所
   （`:34`, `:62`）のみ完了。`:45` だけ旧来の
   `new Promise((r) => setTimeout(r, ...))` が残存している。
   → `sleep(backoffMs(attempt))` に置き換える。

2. **`src/lib/llm/schemas.ts:5-6`** — `.length(4)` / `.max(3)` が
   当初計画どおり `QUIZ_CHOICES_PER_QUESTION`（`src/lib/constants.ts:11`）
   から導出されず、ハードコードのまま残っている。
   → `.length(QUIZ_CHOICES_PER_QUESTION)` / `.max(QUIZ_CHOICES_PER_QUESTION - 1)` に変更。

3. **`tests/e2e/home.spec.ts:26-32`** — 「if/else でどちらに転んでもパスする
   非決定的なテスト」を確定的にする計画だったが、実際の修正は

   ```ts
   if (hasPointerEventsNone) { expect(...).toHaveClass(...) }
   else { expect(...).not.toHaveClass(...) }
   ```

   という、**常にどちらかの分岐で自明に真になるトートロジー**になっており、
   実質的に何も検証していない。非決定性の根本原因（DB状態への依存）は未解決。
   → 元の計画どおり、問題を1件作ってから `/answer` へ遷移できることを
   確定的に検証する形に直す。

### 🟢 軽微: `codemap.md` のドキュメント不整合

`AGENTS.md` の「実装変更と並行して仕様書を更新」ルールに反し、
以下のコードマップが実コードと一致していない
（`openspec/specs/study/spec.md` と `README.md` は正確だった）。

| ファイル                 | 記載                                 | 実際                                                      |
| ------------------------ | ------------------------------------ | --------------------------------------------------------- |
| `codemap.md`（ルート）   | `generateQuizQuestion`               | `generateQuestion`（`src/lib/llm/quiz.ts`）               |
| `src/lib/llm/codemap.md` | `generateQuizQuestion`               | `generateQuestion`                                        |
| `src/lib/llm/codemap.md` | `QUESTION_GENERATION_PROMPT`         | `QUIZ_GENERATION_PROMPT`（`src/lib/llm/prompts.ts`）      |
| `codemap.md`（ルート）   | `createQuestion`（DB保存関数として） | `createKnowledgeWithQuestion`（`question-repository.ts`） |
| `codemap.md`（ルート）   | `types/index.ts`                     | `types/quiz.ts`                                           |

→ 該当箇所の名称を実コードに合わせて修正する。

### ✅ 確認できた正しい点

- Phase 1 のバグ修正3点（無限再フェッチ断ち切り・`res.ok` 検査・`selectedIndex` 追跡）は
  コード上すべて正しく実装されている
- DBスキーマは無変更（`git diff src/lib/db/schema.ts` はフォーマット差分のみ）
- 型分割・API層集約・リポジトリ分割・共通UIコンポーネント・DB遅延初期化（Proxy経由）は
  いずれも設計通り実装されている
- 苦手優先ランダム抽選のSQL最適化（相関サブクエリによる `MAX(answered_at)` 判定）も妥当

### 修正タスク一覧

- [x] `src/app/api/questions/route.ts:45` — ステータスコード `21` → `201` ✅ (fix-7)
- [x] **新規** `tests/api/questions.test.ts` — `POST /api/questions` の実装を
      モックなしで直接テスト（ステータスコード回帰防止）✅ (fix-8)
- [x] `src/lib/llm/parser.ts:45` — `sleep()` ヘルパーに統一 ✅ (fix-7)
- [x] `src/lib/llm/schemas.ts:5-6` — `QUIZ_CHOICES_PER_QUESTION` から導出 ✅ (fix-7)
- [x] `tests/e2e/home.spec.ts:26-32` — トートロジーを解消し、
      問題1件作成後に `/answer` へ遷移できることを確定的に検証 ✅ (fix-8)
- [x] `codemap.md`（ルート） / `src/lib/llm/codemap.md` — 関数名・定数名・パスの誤りを修正 ✅ (fix-7)

### 修正後検証結果

```bash
pnpm type-check      # exit 0
pnpm lint            # exit 0
pnpm test            # 20/20 passed (shuffle, schemas, use-quiz-session, answers, questions)
pnpm test:e2e        # 20/20 passed (chromium + Mobile Chrome)
pnpm build           # exit 0
```

**全修正タスク完了: 2026-08-05**
