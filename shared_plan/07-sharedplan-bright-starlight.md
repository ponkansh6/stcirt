# pre-push カバレッジチェックの厳密化（blocking 化）

## Context

`shared_plan/HOOKS_ADOPTION_PLAN.md` の Phase 1 で `scripts/check-coverage-tiers.mjs` を導入し、`.husky/pre-push` に組み込み済みだが、現状は `|| true` で結果を握りつぶす「参考表示のみ」（non-blocking）。ユーザーは、意図的にモックしている箇所を除いてこれを実効性のある blocking フックにしたい。

実測（`pnpm exec vitest run --coverage`）したところ、以下が判明した:

- テストで丸ごと `vi.mock()` されているモジュール（`src/lib/llm/quiz.ts`、`src/lib/db/repository/question-repository.ts`、`src/lib/db/repository/answer-repository.ts`）は、外部サービス（Gemini API / Turso DB）に直接アクセスするため実カバレッジが意図的に0%。これらは「意図的にモック」に該当し、Tier 判定の対象から除外するのが妥当。
- 上記を除外してもなお、既存の Tier 目標（Tier1: 90%, Tier2: 80%, Tier4: 90%, Tier5: 70%）に対して実カバレッジが大きく不足している（Tier1: 28.3%, Tier2: 36.8%, Tier4: 86.8%, Tier5: 7.4%）。原因は `parser.ts`・`llm/client.ts`・`questions/random` route・UIコンポーネント7種が単純に未テストなこと。
- ユーザーは目標値を下げるラチェット方式ではなく、**目標を維持したまま新規テストを追加してギャップを埋める**方針を選択した。

各ギャップは実装上クローズ可能と判断（後述の見積もりで目標達成見込み）。テスト追加後に `check-coverage-tiers.mjs` と `.husky/pre-push` を blocking に切り替える。

---

## 1. 「意図的にモック」の除外定義

`scripts/check-coverage-tiers.mjs` に除外リストを追加し、Tier 判定対象の `allFiles` から以下を除外する（`vi.mock()` の実績に基づく）:

```js
const INTENTIONALLY_MOCKED = [
  /\/lib\/llm\/quiz\.ts$/, // tests/api/questions.test.ts で丸ごとモック（外部LLM呼び出しのオーケストレーション層）
  /\/lib\/db\/repository\/question-repository\.ts$/, // tests/api/*.test.ts で丸ごとモック（実DBアクセス）
  /\/lib\/db\/repository\/answer-repository\.ts$/, // tests/api/answers.test.ts で丸ごとモック（実DBアクセス）
];
```

これにより Tier 3（Data access）は対象ファイルが0件になり、既存の「⚠️ No files matched」（非失敗扱い）になる。Tier 2 からは `quiz.ts` が外れる。

`llm/client.ts` と `llm/parser.ts` は「呼び出し元でモックされている」わけではなく単に未テストなので除外対象にしない（後述のテストを追加して実カバレッジを積む）。

---

## 2. 新規テスト追加（各 Tier の実ギャップを埋める）

既存パターン（`tests/api/questions.test.ts`, `tests/api/answers.test.ts`, `tests/components/Button.test.tsx`, `tests/answer/use-quiz-session.test.tsx`）を踏襲する。

### Tier 1: Core domain logic（目標 90%）

- **`tests/choice-label.test.ts`**（新規）: `src/lib/choice-label.ts` の `choiceLabel(0)` → `"A."`, `choiceLabel(1)` → `"B."` など数件。
- **`tests/llm/parser.test.ts`**（新規）: `src/lib/llm/parser.ts` の `parseWithRetry` を検証。`"./client"` の `backoffMs` と `"../sleep"` の `sleep` をモックしてリトライ待ち時間をなくす。ケース: 成功、fetcher が throw、fetcher が null 返却、不正JSONでリトライ後失敗、`transform` 失敗でリトライ後失敗、schema 検証失敗でリトライ後失敗、リトライ後に成功。

### Tier 2: API / LLM orchestration（目標 80%、`quiz.ts` 除外後）

- **`tests/llm/client.test.ts`**（新規）: `src/lib/llm/client.ts` を検証。`vi.mock("@google/generative-ai")` で `GoogleGenerativeAI`/`getGenerativeModel`/`generateContent` をモックし、`vi.mock("@/lib/sleep")` でリトライ待ちを除去。ケース: `GOOGLE_API_KEY` 未設定で throw、正常系でテキスト取得、429（レート制限）でリトライ後成功、5xx/overloaded/timeout メッセージでリトライ後成功、リトライ上限超過で throw、`backoffMs()` の純粋関数としての境界値。
- **`tests/api/questions-random.test.ts`**（新規）: `src/app/api/questions/random/route.ts` の `GET` を検証。`vi.mock("@/lib/db/repository/question-repository")` で `pickWeightedRandomQuestion` をモック（既存の `answers.test.ts`/`questions.test.ts` と同じ方針）。ケース: 正常系200、該当なし404、`exclude` クエリのパース（正常値/不正値の除外）、リポジトリが throw した場合の500。

### Tier 4: UI state management（目標 90%）

- **`tests/answer/use-quiz-session.test.tsx`**（既存ファイルに追記）: `select()` の catch ブロック（`src/app/answer/use-quiz-session.ts:72-77`、`submitAnswer` が reject するケース）を検証するテストを1件追加。現在 86.79%（46/53）→ この分岐を通せば 90%超えの見込み。

### Tier 5: UI components（目標 70%）

以下7ファイルに対し `tests/components/*.test.tsx` を新規追加（`Button.test.tsx` と同じ `render`/`screen` パターン）:

- `ChoiceButton.test.tsx`: 各 `variant`（idle/correct/selectedWrong/muted/selected）でのスタイル・アイコン表示、`onClick`/`disabled` の挙動。
- `EmptyState.test.tsx`: `title`/`description` 表示、`actionLabel`+`onAction` 指定時のみボタン表示・クリック動作。
- `ErrorMessage.test.tsx`: `message` 表示、`onRetry` 指定時のみボタン表示、`loading` 伝播。
- `LoadingState.test.tsx`: デフォルトラベル、`label` 上書き。
- `NavLink.test.tsx`: `href`/`className` の伝播、children 表示（`next/link` の `useLinkStatus` は `Link` 配下でそのまま動作する想定。動作しない場合は `next/link` を最小限モックする）。
- `QuestionCard.test.tsx`: 選択肢表示、`correctIndex`/`selectedIndex` によるスタイル分岐、`onSelect` ありなしでの `button`/`div` 切り替えとクリック動作。
- `ResultBanner.test.tsx`: `isCorrect` true/false でのメッセージ・スタイル切り替え。

各コンポーネントは10行未満の小規模ファイルのため、上記テストでほぼ100%到達見込み（Tier5 全体で 70% を十分に超える）。

---

## 3. `scripts/check-coverage-tiers.mjs` を blocking に変更

- 上記 `INTENTIONALLY_MOCKED` 除外リストを追加し、`allFiles` 算出時にフィルタ。
- `main()` 末尾の `process.exit(0); // Phase 1 is non-blocking` を `process.exit(allPass ? 0 : 1);` に変更。
- 見出し文言から `(Phase 1)` を除去し、"non-blocking for Phase 1" のメッセージも実態に合わせて修正。
- Tier 定義自体（ファイルパターン・目標値）は変更しない。

## 4. `.husky/pre-push` を blocking に変更

現状:

```sh
pnpm exec vitest run --coverage 2>/dev/null
node scripts/check-coverage-tiers.mjs || true
```

を、既存の E2E ブロックと同じスタイルで exit code を明示チェックする形に変更:

```sh
pnpm exec vitest run --coverage
COVERAGE_EXIT_CODE=$?
if [ $COVERAGE_EXIT_CODE -ne 0 ]; then
  echo "Coverage run failed with code $COVERAGE_EXIT_CODE"
  exit $COVERAGE_EXIT_CODE
fi
node scripts/check-coverage-tiers.mjs
TIER_EXIT_CODE=$?
if [ $TIER_EXIT_CODE -ne 0 ]; then
  echo "Coverage tier check failed with code $TIER_EXIT_CODE"
  exit $TIER_EXIT_CODE
fi
```

コメント見出しも `# --- Coverage tier report (non-blocking, Phase 1) ---` → `# --- Coverage tier check (blocking) ---` に変更。`src/` 変更時のみ実行するガード（`echo "$PUSH_FILES" | grep -qE "^src/"`）はそのまま維持。

## 5. ドキュメント同期

- `AGENTS.md` の「仕様書管理」節にある「カバレッジ Tier レポートを表示（`scripts/check-coverage-tiers.mjs`、non-blocking、Phase 1）」の記述を、blocking化された旨・除外定義（意図的にモックされたモジュールは対象外）に更新する。
- 本プランを `shared_plan/COVERAGE_STRICT_HOOK_PLAN.md` として保存する（実装ステップの一つとして実施）。`shared_plan/HOOKS_ADOPTION_PLAN.md` と同じ体裁（Context / 採用する項目 / 変更内容 / テスト / 進捗）で記述する。

---

## 実装順序

1. `tests/choice-label.test.ts` 追加
2. `tests/llm/parser.test.ts` 追加
3. `tests/llm/client.test.ts` 追加
4. `tests/api/questions-random.test.ts` 追加
5. `tests/answer/use-quiz-session.test.tsx` に `select()` catch 分岐のテスト追加
6. `tests/components/{ChoiceButton,EmptyState,ErrorMessage,LoadingState,NavLink,QuestionCard,ResultBanner}.test.tsx` 追加
7. `pnpm exec vitest run --coverage && node scripts/check-coverage-tiers.mjs` を実行し、各 Tier が目標を満たすことを確認（満たさない場合はテストを追加、またはどうしても到達不能な分岐がある場合はユーザーに相談してから目標を調整）
8. `scripts/check-coverage-tiers.mjs` に `INTENTIONALLY_MOCKED` 除外と exit code 変更を適用
9. `.husky/pre-push` を blocking 化
10. `AGENTS.md` 更新
11. `shared_plan/COVERAGE_STRICT_HOOK_PLAN.md` を作成し、本プランと実施結果を記録
12. `pnpm type-check` / `pnpm lint` / `pnpm test` / `bash scripts/check-spec-refs.sh` で最終確認

AGENTS.md の制約に従い、`--no-verify` / `HUSKY=0` は使用しない。

---

## 実装記録

- **実施日**: 2026-08-05
- **ステータス**: 完了
- **追加したテスト一覧**:
  1. `tests/choice-label.test.ts`
  2. `tests/llm/parser.test.ts`
  3. `tests/llm/client.test.ts`
  4. `tests/api/questions-random.test.ts`
  5. `tests/answer/use-quiz-session.test.tsx`（`select()` 失敗時の catch 分岐追記）
  6. `tests/components/ChoiceButton.test.tsx`
  7. `tests/components/EmptyState.test.tsx`
  8. `tests/components/ErrorMessage.test.tsx`
  9. `tests/components/LoadingState.test.tsx`
  10. `tests/components/NavLink.test.tsx`
  11. `tests/components/QuestionCard.test.tsx`
  12. `tests/components/ResultBanner.test.tsx`
  - ユニットテスト合計件数: 76件全パス
- **実測カバレッジ（除外適用前）**:
  - Tier 1: 97.83%
  - Tier 2: 87.50%
  - Tier 3: 0.00%（意図的モック）
  - Tier 4: 90.57%
  - Tier 5: 100.00%
- **`INTENTIONALLY_MOCKED` 除外対象**:
  - `src/lib/llm/quiz.ts`
  - `src/lib/db/repository/question-repository.ts`
  - `src/lib/db/repository/answer-repository.ts`
- **除外適用後の Tier 判定結果**: 全 Tier が目標値をクリアし、スクリプトは `exit 0` で正常終了。
- **blocking 化したファイル**:
  - `scripts/check-coverage-tiers.mjs`（`process.exit(allPass ? 0 : 1)` へ変更）
  - `.husky/pre-push`（`pnpm exec vitest run --coverage` および `check-coverage-tiers.mjs` の終了コードを明示チェックして失敗時は exit）
- **ドキュメント更新**: `AGENTS.md` の仕様書管理セクションの自動チェック記述を blocking / 除外対応版に更新。
- **Phase 2 以降の注意点**: Tier 3 は対象ファイルが0件のため「⚠️ No files matched」（非失敗扱い）となる。将来リポジトリ構成変更や新規リポジトリ追加等でファイルが対象になった場合は再評価が必要。
