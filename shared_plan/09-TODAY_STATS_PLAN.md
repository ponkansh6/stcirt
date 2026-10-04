# 統計を「本日の解答数 / 本日の正答率」に変更

## Context

ホーム画面 (`src/app/page.tsx`) の統計セクションは現在 **問題数 / 解答数 / 正答率** の 3 カラムで、解答数・正答率はアプリ開始以来の**累計**を表示している。累計値は日々ほとんど変化しないため学習のモチベーション指標として機能していない。

これを **問題数 / 本日の解答数 / 本日の正答率** に変更し、「今日どれだけ解いたか」が一目で分かるようにする。

- 「本日」の境界は **JST 固定 (Asia/Tokyo, UTC+9)**。`answer_logs.answered_at` は UTC unixepoch 秒で保存され、Vercel 実行環境は UTC のため、サーバー TZ に依存しない固定オフセット計算とする。
- 3 カラム構成は維持（累計の解答数・正答率は表示しない）。
- `answer_logs_answered_at_idx` は既存だが現在どのクエリからも使われていない。今回の日付範囲フィルタで初めて活用される。

## 変更内容

### 1. JST 日境界ユーティリティを新規追加 — `src/lib/date.ts`

リポジトリに日付/TZ ヘルパーは一切存在しないため新規作成する。JST は DST がないので固定オフセットで正確に計算できる。

```ts
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 指定時刻が属する JST の日の 00:00 を、UTC 基準の Date として返す */
export function jstDayStart(now: Date = new Date()): Date {
  const jstMs = now.getTime() + JST_OFFSET_MS;
  return new Date(Math.floor(jstMs / DAY_MS) * DAY_MS - JST_OFFSET_MS);
}
```

純関数・依存なしなので Tier 1（コアドメインロジック）扱いにする。

### 2. `getStats()` を本日集計に変更 — `src/lib/db/repository/answer-repository.ts:17-36`

- `totalQuestions`（`questions` テーブルの COUNT）は**そのまま維持**。`page.tsx` の「問題を解く」リンク活性判定にも使われているため必須。
- `answerLogs` の 2 本の COUNT に `gte(answerLogs.answeredAt, jstDayStart())` を追加。正解数側は `and(...)` で `eq(answerLogs.isCorrect, 1)` と結合。
- drizzle の `mode: "timestamp"` により `Date` を渡すと unix 秒に変換されるため、追加の変換は不要。
- 戻り値を `{ totalQuestions, todayAnswers, todayAccuracy }` にリネーム。`todayAccuracy` は `todayAnswers > 0 ? todayCorrect / todayAnswers : 0`（既存の 0 除算ガードと同じ形）。
- import に `and`, `gte` を `drizzle-orm` から追加。

### 3. ホーム画面のラベルと変数を更新 — `src/app/page.tsx:7, 47-54`

- 分割代入を `{ totalQuestions, todayAnswers, todayAccuracy }` に変更。
- ラベル: 「解答数」→「**本日の解答数**」、「正答率」→「**本日の正答率**」。
- 表示ロジック（`Math.round(todayAccuracy * 100)}%`）とグリッド `grid-cols-3` は変更なし。本日 0 件のときは `0` / `0%` を表示する。
- ラベルが長くなるため `text-xs` のまま折り返しを確認（3 カラムで「本日の解答数」は 6 文字、モバイル幅で 2 行になる可能性あり → 必要なら `whitespace-nowrap` を外して自然折り返しに任せる）。

### 4. 仕様書を同期 — `openspec/specs/study/spec.md`

`.husky/pre-push` の `check-spec-refs.sh` が blocking なので必須。

- **R5: Dashboard & Stats**（70 行目付近）: `totalAnswers` / `overallAccuracy` → `todayAnswers` / `todayAccuracy` に置換し、「JST (UTC+9) の当日 00:00 以降の解答ログを集計」という制約を追記。
- **Components §1**（101 行目付近）: 「問題数 / 解答数 / 正答率」→「問題数 / 本日の解答数 / 本日の正答率」。
- **Data Model** または新規の短いセクションに `src/lib/date.ts` の `jstDayStart()` を記載。バッククォート内の `src/` パスは実在チェックされるため、ファイル作成後にのみ参照を書くこと。

### 5. codemap を更新

リポジトリ規約のディレクトリ別 codemap:

- `src/lib/codemap.md` — `date.ts` を追加。
- `src/lib/db/codemap.md` — `getStats()` の説明を本日集計に更新。
- `src/app/codemap.md` — ホーム画面の統計表示の記述を更新。

### 6. テスト

- **新規 `tests/date.test.ts`** — `jstDayStart()` の境界値テスト。既存の `tests/shuffle.test.ts` / `tests/choice-label.test.ts` と同じ純ユニットスタイル（`describe`/`it` を `vitest` から明示 import、番号付きの説明的テスト名）。
  - `2026-08-05T14:59:59Z`（JST 8/5 23:59:59）→ `2026-08-04T15:00:00Z`
  - `2026-08-05T15:00:00Z`（JST 8/6 00:00:00）→ `2026-08-05T15:00:00Z`
  - JST 00:00 ちょうど、月/年をまたぐケース
- **`tests/e2e/home.spec.ts:11-12`** — `text=解答数` / `text=正答率` を `text=本日の解答数` / `text=本日の正答率` に更新。※ Playwright の部分一致で旧セレクタも通ってしまうため、明示的に新ラベルへ書き換える。
- **`scripts/check-coverage-tiers.mjs`** — Tier 1（目標 90%、`lib/shuffle.ts` 等）のパターン配列に `lib/date.ts` を追加。`answer-repository.ts` は `INTENTIONALLY_MOCKED` のため Tier 3 の判定対象外で、今回の変更ではカバレッジ要件は増えない。
- `tests/api/answers.test.ts` は `recordAnswer` をモックしており `getStats()` に触れないため**変更不要**。

### 7. 本プランを `shared_plan/` に配置

リポジトリ規約に合わせ、本ファイルを `shared_plan/TODAY_STATS_PLAN.md` としてコピーする。

## 実装記録

- 実施日: 2026-08-05
- ステータス: 完了
- 変更ファイル:
  - `src/lib/date.ts`: 新規作成 (JST 日境界判定 `jstDayStart`)
  - `src/lib/db/repository/answer-repository.ts`: `getStats()` を本日の JST 統計集計に変更
  - `src/app/page.tsx`: ホーム画面の表示ラベルを「本日の解答数」「本日の正答率」に変更し、新統計変数を適用
  - `openspec/specs/study/spec.md`: 仕様書 R5 と Components §1 を本日の JST 統計に同期
  - `src/lib/codemap.md`, `src/lib/db/codemap.md`, `src/app/codemap.md`: 各種 codemap の更新
  - `tests/date.test.ts`: 新規作成 (`jstDayStart` の境界値ユニットテスト)
  - `tests/e2e/home.spec.ts`: E2E テストのラベル検証を更新
  - `scripts/check-coverage-tiers.mjs`: Tier 1 対象に `date.ts` を追加
  - `shared_plan/TODAY_STATS_PLAN.md`: プランファイルの配置
- 検証結果:
  - `pnpm test`: 全テスト通過 (date.test.ts 含む)
  - `pnpm type-check`: 通過
  - `pnpm lint`: 通過
  - `bash scripts/check-spec-refs.sh`: 終了コード 0 (正常)
  - カバレッジ Tier 1 ~ 5: 全て目標達成・パス

1. `pnpm test` — `tests/date.test.ts` を含む Vitest 全体が通ること。
2. `pnpm type-check` — `getStats()` の戻り値リネームによる型エラーが残っていないこと（`page.tsx` 以外に呼び出し元がないことは確認済み）。
3. `pnpm lint` / `pnpm format:fast`。
4. `pnpm dev` でホームを開き、統計が「問題数 / 本日の解答数 / 本日の正答率」になっていること、モバイル幅（Pixel 5 相当）でラベルが崩れないことを目視確認。
5. `/answer` で数問解いてからホームに戻り、本日の解答数がインクリメントされること（`dynamic = "force-dynamic"` のためリロードで即反映）。
6. `pnpm test:e2e` — `tests/e2e/home.spec.ts` の新ラベル検証が通ること。
7. `pnpm exec vitest run --coverage && node scripts/check-coverage-tiers.mjs` — Tier 1 が 90% を維持すること。

### 日付境界の手動確認（任意）

DB に UTC で `2026-08-05T14:59:00Z` と `2026-08-05T15:30:00Z` の `answered_at` を持つログを入れ、JST 8/6 として実行したとき前者が本日分に含まれず後者が含まれることを確認する。
