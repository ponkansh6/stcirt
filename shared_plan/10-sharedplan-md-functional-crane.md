# Study アプリ リファクタリング / テスト充実化 / 最適化プラン

## Context

`/home/shunki/working/study` は Next.js 16 + Drizzle/Turso + Gemini の個人用学習アプリ(src/ 約 1,150 行、テスト 22 ファイル / 96 ケース)。実装自体は動いているが、探索の結果、次の 4 系統の問題が確認された。

1. **本番バグ**: `src/lib/api/client.ts:19` 等が `res.statusText` を使用。Vercel は HTTP/2 で配信するため `statusText` は常に空文字になり、ユーザーには `"Failed to fetch random question: "` と表示される。API レスポンスに Zod 検証がなく `any` が流れており、それが 2 件の型不一致(`explanation` の null 許容、`createdAt` の有無)を隠している。
2. **カバレッジゲートの空洞化**: 全体 55.64%。`scripts/check-coverage-tiers.mjs` の Tier 3(データアクセス 75%)は、対象 2 ファイルが両方 `INTENTIONALLY_MOCKED` に入っているため常に "No files matched" → `continue` で **pass/fail 判定に到達せず、恒久的に素通り**する。`src/lib/api/client.ts` (61%) はどの Tier にも一致せず無防備。Tier 4 は目標 90% に対し 90.57% と 0.57pt しか余裕がない。
3. **重複と死んだコード**: fetch ラッパー 3 重複、API catch ブロック 3 重複、`page.tsx` が Button のクラス文字列を手写し。`createQuestion` は定義されているのに `create/page.tsx` が同じ POST を再実装している(重複かつデッド)。
4. **破壊的な migrate スクリプト**: `scripts/migrate.ts:23-34` は `TURSO_DATABASE_URL` に対して**無条件に全テーブルを DROP** する。`drizzle.config.ts` が宣言する `src/lib/db/migrations` は存在せず、schema が二重定義されている。

**方針(確認済み)**: 個人用プロトタイプのまま。認証・レート制限・SQL 側抽選は対象外。安価な最適化のみ行う。migrate.ts は実マイグレーションへ置き換える。

**ゴール**: 実バグを潰し、カバレッジゲートを実効化し、重複を排除し、安価な性能改善を入れる。

---

## 最重要: pre-push ゲートの実際の挙動(検証済み)

計画順序はすべてこの 3 点に依存する。実際に読んで確認した。

| 事実                                                                                                                            | 根拠                  | 帰結                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------- |
| **カバレッジ実行は `^src/` に一致する差分がある時だけ**発火                                                                     | `.husky/pre-push:39`  | src/ を触らない push はカバレッジゲートを完全にスキップできる         |
| pre-push は **`origin/main...HEAD` のレンジ全体**を 1 回評価                                                                    | `.husky/pre-push:4-5` | コミット数は無料。**push 回数だけがコスト**                           |
| `check-spec-refs.sh` は spec.md 内のバッククォート付き `src/`・`tests/` パスのみ検証。実際の該当は **8 件、すべて `src/` 配下** | `grep` で確認済み     | **本計画のどの変更もこの 8 件を削除しない。ブロッキングリスクはゼロ** |

spec.md の 8 件: `src/lib/date.ts`, `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/create/page.tsx`, `src/app/answer/page.tsx`, `src/components/`, `src/lib/choice-label.ts`, `src/lib/db/index.ts`

補足:

- `tests/` 参照は **0 件** → テスト構造の再編は完全に自由。
- `scripts/migrate.ts` は正規表現に一致しない → 削除は無条件に安全。
- spec.md に **テスト/カバレッジのセクションは存在しない**(検証済み)。`check-coverage-tiers.mjs` のヘッダーは「targets defined in spec.md」と書いているが**嘘**。Tier 目標の変更に spec 編集は不要。
- **唯一この gate を壊す方法**は、まだ存在しないパスをバッククォート付きで spec.md に追記すること。新規ファイル(`weighting.ts` 等)の spec 記載は**必ず同一コミット**で。
- `check-prod-schema.sh` はテーブルとカラムのみ比較し、**インデックスは見ない** → Phase 2 のインデックス変更はドリフト検出に引っかからない。

### 全 push 前に実行する dry-run(1 行、安い順に fail-fast)

```
bash scripts/check-spec-refs.sh && pnpm exec tsgo --noEmit && pnpm test:coverage && node scripts/check-coverage-tiers.mjs && pnpm test:e2e
```

**カバレッジの増減は推論せず必ず計測すること。** リファクタは分子と分母を同時に動かす。

---

## Phase 0 — src/ を触らない衛生作業 · 1 push · **カバレッジゲートをスキップ**

すべて src/ 外。純粋な削除のみでカバレッジ影響ゼロ。

- `.eslintcache` を untrack し `.gitignore` に追加(現在 git 管理下)
- `package.json` から未使用依存 `p-limit`・`@vercel/config` を削除
- `test:prod` / `test:build-parity` スクリプトと `tests/vitest.integration.config.ts` を削除(存在しない `tests/production`・`tests/build` を指している)
- `@server/*` エイリアスを `tsconfig.json` と `vitest.config.ts` の両方から削除(`server/` は存在しない)。空ディレクトリ `src/lib/db/api/` も削除
- `openspec/config.yaml` を実装に合わせて書き直す(現状「CSS Modules・Tailwind なし」「4択10問」「`src/app/quiz/[id]/`」「DB 保存しない」と、すべて spec.md と実装に矛盾)
- `scripts/check-coverage-tiers.mjs:82-84` の恒等関数 `metricKey()` を削除
- `.github/workflows/main.yml` に `check-spec-refs.sh` / `test:coverage` + `check-coverage-tiers.mjs` / `security-check` を追加(現在 CI はこれらを一切実行しておらず、ローカル pre-push 専用になっている)。**E2E は CI に入れない**(遅い、当面ローカルのまま)

検証: `bash scripts/check-spec-refs.sh && pnpm test:all && pnpm exec tsgo --noEmit`

---

## Phase 1 — テスト基盤整備 + tests/ の型検査・lint 有効化 · 1 push · **まだ src/ 非依存**

**新規テストを書く前に**実施する。そうすれば既存 1,800 行と以後追加分がまとめて型検査される。

- `tsconfig.json:36` の `exclude: ["tests/**"]` を解除、`eslint.config.mjs:32` の tests 無視も解除。**先に `pnpm exec tsgo --noEmit` を単独実行して型エラーの件数を把握する**(10 秒で分かる。多すぎれば descope 判断)
- `tests/helpers/` と `tests/fixtures/` を新設(下記構造)
- 既存テストを fixture に移行。`tests/llm/client.test.ts` の `globalThis as unknown as {process?...}` キャスト 3 箇所を `tests/helpers/env.ts` に集約
- クリーンアップを統一: `tests/setup.ts` にグローバル `afterEach(() => vi.restoreAllMocks())` を置き、各ファイルの `clearAllMocks`/`restoreAllMocks` を削除(現状ファイルごとにバラバラ)

```
tests/
  helpers/
    db.ts       createTestDb() → :memory: libsql + drizzle + migrator で実マイグレーション適用
    env.ts      withEnv({ GOOGLE_API_KEY: ... })
    fetch.ts    mockFetch(), jsonResponse(body, status)
  fixtures/
    question.ts makeQuestion(), makeQuestionRow()
    answer.ts   makeAnswerResult(), makeAnswerLog()
    llm.ts      validLlmJson, malformedLlmJson
  setup.ts      グローバル afterEach
```

**`tests/fixtures/*` には `vitest` を import しない。** そうすれば Playwright 側の `tests/e2e/answer.spec.ts` から直接 import でき、重複している `sampleQuestion` / `sampleAnswerResult` を排除できる。

> `tests/helpers/db.ts` の実体追加は Phase 2(マイグレーション生成後)。ここでは他の helper のみ。

---

## Phase 2 — 実マイグレーション化 · 1 push · src/ は schema.ts のみ

- **スキーマ変更を先に入れてから** `pnpm db:generate` する(baseline 1 本で済ませ、直後に index マイグレーションを足さないため):
  - `src/lib/db/schema.ts:30` の明示 index `questions_knowledge_id_idx` を削除(`:19` の `.unique()` が既に一意インデックスを作るため冗長。書き込み増幅のみ)
  - `answer_logs` に複合インデックス `(question_id, answered_at DESC)` を追加(`question-repository.ts:81-85` の相関サブクエリがグループごとにソートしている)
- `src/lib/db/migrations/` に baseline を生成
- `scripts/migrate.ts` を**削除**、`"db:migrate": "drizzle-kit migrate"` を追加。`schema.ts` が唯一の真実になる
- `tests/helpers/db.ts` をここで追加(マイグレーション実体に依存するため)

**本番の baseline 化**: 本番には既にテーブルがあるため、生成された `CREATE TABLE` baseline はそのまま再生できない。プロトタイプでの最短手順は — 本番に `drizzle-kit push` を 1 回だけ当ててインデックス差分を反映 → `meta/_journal.json` のハッシュを使って `__drizzle_migrations` に baseline 行を手動 INSERT。以後の `migrate` が正しい地点から始まる。

検証: `pnpm test:coverage && node scripts/check-coverage-tiers.mjs`(`schema.ts` はどの Tier にも一致しないため安全)。push 前に `check-prod-schema.sh` を手動実行。

---

## Phase 3 — バグ修正 + 低リスク重複排除 · 1 push

**実バグはここで死ぬ。** 対象はほぼ無ゲート領域(`lib/api/*`)なので早めに出す。

- **`src/lib/api/client.ts` を全面書き直し**
  - 3 つのラッパー(`:13-22`, `:24-37`, `:39-49`)を単一の `request(path, init, label)` に集約
  - `res.statusText` を廃止(HTTP/2 で空文字 = 実バグ)。`fail()` (`src/lib/api/response.ts:7`) が返す `{ error }` ボディを読んでメッセージに使う。現状この API エラー契約は書かれているのに一度も消費されていない
  - Zod レスポンススキーマを追加 → `parseJsonOrThrow` の暗黙 `any` が消える
  - デッドな `createQuestion` は**削除せず活かす**: `src/app/create/page.tsx:23-29` のインライン重複を `createQuestion()` 呼び出しに差し替える
- **`any` が隠していた型不一致 2 件を修正**
  - `src/types/quiz.ts:16` `explanation?: string` → `string | null`(`schema.ts:24` が nullable、`answers/route.ts:33` がそのまま返す)
  - `create/page.tsx:29` が `Question`(= `createdAt` を含む)と称しているが `POST /api/questions` (`questions/route.ts:36-46`) は `createdAt` を返さない → **クライアント側の型を狭める**(レスポンスを増やすのではなく)
- `src/lib/api/response.ts` に `withErrorHandling()` を追加し、3 ルートの同一 catch ブロック(`questions/route.ts:47-50`, `questions/random/route.ts:24-27`, `answers/route.ts:35-38`)を置換
- **`src/lib/llm/parser.ts`**
  - 3 回コピーされた retry tail(`:33-37`, `:44-49`, `:61-65`)を抽出
  - `:17-20` が `callGemini` の**全例外**を `null` に潰している。恒久エラーである `"GOOGLE_API_KEY environment variable is not set"` (`client.ts:16`) は**再 throw** し、設定ミスとモデルの JSON 不良を区別する
  - `:43` の完全に無言な `catch {}` にログを追加(兄弟の catch は両方 `console.warn` している)
  - `transform` 引数(`:10`, `:40-50`)を削除(本番から一度も呼ばれず、テストのみが到達)
- `src/lib/llm/client.ts:35` の `err as { status?: number; message?: string }` を絞り込みガードに置換
- `src/lib/db/index.ts:35` を `Reflect.get(actualDb, prop)` に(proxy を receiver に渡すと getter 経由で再帰する潜在バグ。現状は Drizzle が getter を公開していないため偶然動いている)
- `tests/api/client.test.ts` を新規追加 — statusText バグとエラーボディ経路の**回帰テスト**

**カバレッジ影響(順に注意)**: `lib/api/*` は無 Tier → 自由。`parser.ts` は **Tier 1 @90%** で、カバー済み行(`transform`)とそのテストを同時に削除するため分子・分母が両方動く。`api/*` は **Tier 2 @80%** で、`withErrorHandling` がカバー済み catch を無ゲートの `response.ts` へ移す → 同じく両方動く。**必ず計測すること。** Tier 1 が落ちたら revert ではなく parser のエッジケーステストを追加する。

---

## Phase 4 — 純粋ロジックの抽出 · 1 push · **これが Tier 3 の修正そのもの**

- `pickWeightedRandomQuestion` (`src/lib/db/repository/question-repository.ts:70-148`, 78 行)から重み計算を **`src/lib/db/repository/weighting.ts`** へ抽出。純粋関数 `computeWeight({ answered, correct, latestIncorrect })` と `pickByWeight(items, rng)`。リポジトリには IO だけを残す
- `src/app/answer/quiz-runner.tsx:53-68` の選択肢 variant ステートマシンを **`src/app/answer/choice-state.ts`** へ抽出(純粋)。ついでに `:60` の `.indexOf()` を `.map()` の外へ巻き上げる(選択肢ごとに再計算されている)
- **両方の単体テストを同一コミットで**追加

**仕掛け**: `weighting.ts` は Tier 3 のパターン `/lib/db/repository/.+\.ts$/` に一致し、かつ `INTENTIONALLY_MOCKED` に入っていない → **このファイルが着地した瞬間に Tier 3 が自動的に息を吹き返す**。テストなしで置けば即座に約 0% で fail する。狙った挙動であり、望んでいたリファクタの副作用として死に Tier が復活する。

spec.md 同時更新: L139 の Weighted Random Selection を `weighting.ts` に、L110-114 の `/answer` に `choice-state.ts` を追記。**新規パスをバッククォートで書くなら必ず同一コミット。**

---

## Phase 5 — リポジトリ / オーケストレーションのテスト · 1 push

- `tests/db/question-repository.test.ts`, `tests/db/answer-repository.test.ts` — `tests/helpers/db.ts` の in-memory libsql + `vi.mock("@/lib/db")` で実行
  - **JST 日境界をまたぐ行を含むケースを必ず書く**(`src/lib/date.ts` の `jstDayStart()` 依存)。これが Phase 7 の集計クエリ書き換えの防護網になる
- `tests/llm/quiz.test.ts`
- その後、**`INTENTIONALLY_MOCKED` から 3 エントリすべてを削除**。Tier 3 が実ファイル 2 本を 75% でゲートし、Tier 2 が `quiz.ts` を拾う
  - **テストを先に green にしてから、同一 push 内の後続コミットで削除する**(順序を逆にすると Tier 3 が約 0% で fail)

> `db/index.ts` の `NEXT_BUILD` → `:memory:` フォールバックは**リポジトリテストに再利用できない**(検証済み): モジュールレベルの `dbInstance` シングルトンが worker 内で残る / その in-memory DB に DDL が一度も流れずテーブルが存在しない / `NEXT_BUILD` をグローバルに立てると `TURSO_DATABASE_URL` 欠落を隠す。専用 helper が必要。

副産物: helper が実マイグレーション SQL を適用するため、**スキーマとマイグレーションのドリフトが単体テストで壊れる**ようになる。

---

## Phase 6 — カバレッジ Tier スクリプトの実効化 · 1 push

コード形状が確定した**後**に実施。目標値を推測でなく実測に対して設定するため。

`scripts/check-coverage-tiers.mjs`:

- **(a) 済(Phase 4)** — Tier 3 に実ファイルが入ったことが (b) の前提
- **(b) "No files matched" をハード失敗にする。** 現在 `:127-130` で pass/fail 分岐の**手前**で `continue` するため、Tier が黙って死ぬ。Tier 3 が実体を持った後でのみ安全
- **(c) `/lib/api/.+\.ts$/` の Tier を目標 85% で追加。** `client.ts` (61.11%) と `response.ts` は Phase 3 の `request()` 集約後は小さく自明にテストできる。85 は願望でなく実測ベース

目標値の調整:

- **Tier 4 の 0.57pt マージンはカバレッジを上げて解く問題ではない。** 集計対象がちょうど 1 ファイルなので 3 行の編集で振れる。**構造的に直す**: パターンを `/app/answer/.+\.(ts|tsx)$/` に広げる。ただし **Phase 4/5 で `quiz-runner.tsx` と `choice-state.ts` に実カバレッジが付いた後に限る**(先にやると 0% の 2 ファイルを巻き込んで即 fail)。3 ファイル集計なら余裕が出る
- **Tier 4 に `branches` を第 2 ゲートとして 75% で追加。** 現状 statements 90.57% に対し **branches は 70.37%** で、statements のみのゲートは実態を過大評価している。ステートマシン hook を statements だけで測るのは間違った対象を測っている
- Tier 1 (90) / Tier 2 (80) / Tier 5 (70) は据え置き
- `src/lib/db/schema.ts` を coverage の `include` から除外(宣言的で分岐ゼロ、ノイズにしかならない)

**spec.md にテストセクションを新設する。** 現状 spec.md にテスト/カバレッジの記述は皆無なのに、スクリプトのヘッダーは「targets defined in spec.md」と主張している。Tier 構成と目標値をここに書いて嘘を解消する。

---

## Phase 7 — UI 重複排除 + 性能 · 1 push

Phase 5 のリポジトリテストが SQL 書き換えの回帰網になるため、それが前提。

**重複排除**

- `src/lib/cn.ts` を追加し、`Button.tsx:24-30` / `NavLink.tsx:29-31` / `QuestionCard.tsx:42,51` の手書きクラス結合に適用
- `src/app/page.tsx:19,28` が Button のデザインシステムクラス文字列を手写ししている(`Button.tsx:17,18,25` と重複)→ `Button` の variant を使う。現状 Button を restyle すると home が黙って崩れる
- `Spinner` を抽出(`Button.tsx:37-40`, `ChoiceButton.tsx:46`, `LoadingState.tsx:8` の 3 箇所)。**テストを同一コミットで。** `src/components/` に着地するため 0% だと Tier 5 の集計を即座に薄める
- `errorMessage()` ヘルパーを追加し `use-quiz-session.ts:44,76` と `create/page.tsx:31` の `e instanceof Error ? ... : ...` を集約

**デッドコード削除**

- `QuestionCard` のインタラクティブ分岐と `onSelect` / `selectedIndex` / `disabled` props(`QuestionCard.tsx:7-9,36-48`)— 唯一の本番呼び出し元 `create/page.tsx:61-65` は `onSelect` を渡さず、`/answer` は `ChoiceButton` を使う。テストのみが到達
- `src/types/quiz.ts:3,5` の `Knowledge` / `AnswerLog` 型(参照ゼロ)

**性能(プロトタイプ規模なので安価な勝ちのみ)**

- `question-repository.ts:73` の `db.select().from(questions)` — 1 行返すために全行 × 全カラム(本文 + choices JSON + explanation)を Turso から引いている。**必要カラムのみに射影**し、独立している `:76` の統計クエリと `Promise.all` にする
- `answer-repository.ts:20,21-24,25-28` の逐次 COUNT 3 本を単一の条件付き集約クエリに統合(#2 と #3 は同一テーブル・同一述語)。`src/app/page.tsx:4` が `force-dynamic` でキャッシュなしのため、home 表示ごとに Turso へ 3 往復している
- `use-quiz-session.ts:52-81` の `select` の依存配列が `[phase]` → 毎レンダーで新しい識別子になる。関数形式 `setPhase` にして `[]` にする
- `src/app/create/page.tsx:1` — 静的マークアップを含めてページ全体が `"use client"`。server shell + `"use client"` フォーム子コンポーネントに分割

spec.md 同時更新: L105-107(`/create` の分割)、L116-125(`Spinner.tsx`・`src/lib/cn.ts` 追加、`QuestionCard` の props 削除)。

---

## コミット / push 粒度

支配的な事実: **pre-push は push ごとに 1 回、レンジ全体を評価する。コミット数は無料。**

- **コミット**は論理単位ごとに細かく(バグ 1 件、抽出 1 件)。pre-commit は oxlint + oxfmt + tsgo + `vitest related` で数秒。細かいほど `vitest related` の対象も狭い
- **push は Phase ごとに 1 回** → 全体で **約 7 回の pre-push サイクル**
- Phase 0・1 は src/ 非依存 → その push はカバレッジ実行を丸ごとスキップする。**意図的に先頭に置いている**
- **独立妥当性のルール**: `src/` 配下に**新規ファイル**を追加するコミットは、テストを同一コミットに含める。v8 は `include: ["src/**"]` なので未テストファイルを 0% で計上する。`weighting.ts`(Tier 3)と `Spinner.tsx`(Tier 5)は単独で置くと確実に fail する。`cn.ts` は無 Tier なので影響なし

**申し送り(実施しない、判断のみ提示)**: pre-push は `pnpm test:all` の後に `vitest run --coverage` を実行しており、**同じスイートを 2 回**回している。1 回のカバレッジ実行に統合すれば全 push が速くなる。ただし `.husky/` の変更は AGENTS.md の精神に対する判断を要するため、勝手に行わず提起に留める。

---

## テスト追加の優先順位(効果 / 労力)

| #   | 対象                | 方法                                  | 理由                                                                                                  |
| --- | ------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | `weighting.ts`      | 純粋単体、テーブル駆動                | 基底 5 / `1+4*ratio` / +2 ボーナス / 直近 10 件除外 というドメイン規則を固定。**Tier 3 を復活させる** |
| 2   | `choice-state.ts`   | 純粋単体                              | 安い。JSX 内の分岐スープを排除                                                                        |
| 3   | `lib/api/client.ts` | `mockFetch` helper                    | statusText 実バグと未消費のエラー契約を直接カバー。現状 61% で無ゲート                                |
| 4   | 両リポジトリ        | in-memory libsql + 実マイグレーション | 相関サブクエリ、新複合インデックス、そして **Phase 7 の集計クエリ書き換え**を守る                     |
| 5   | `create/page.tsx`   | RTL、正常系 + エラー系のみ            | 現在 0/27。2 本でほぼ埋まる                                                                           |
| 6   | `quiz-runner.tsx`   | 各 phase のレンダースモーク           | 現在 0/32。ステートマシン抽出後は薄い                                                                 |
| 7   | `db/index.ts`       | 約 5 行                               | `Reflect.get` 修正の回帰テスト                                                                        |
| 8   | `sleep.ts`          | fake timers、3 行                     | 集計を引っ張るのを止めるためだけ                                                                      |

**対象外**: `layout.tsx` / `page.tsx`(server component、E2E で足りる)、`db/schema.ts`(テストせず coverage から除外する)

---

## リスクと最短の検証手段

| リスク                                                                                              | Phase | 最短の検証                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tsconfig で `tests/**` を有効化すると型エラーが大量に出る                                           | 1     | **他に何も触る前に** `pnpm exec tsgo --noEmit` を単独実行。10 秒で規模が分かり descope 可能                                                                      |
| 生成した `CREATE TABLE` baseline は既存本番 DB に再生できない                                       | 2     | `check-prod-schema.sh` は index を見ないため実リスクは `__drizzle_migrations` の帳簿だけ。`createTestDb()` が `:memory:` にクリーンに適用できれば SQL 自体は健全 |
| `withErrorHandling` がカバー済み行を Tier 2 から無ゲート `response.ts` へ移し、比率が予測不能に動く | 3     | `pnpm test:coverage && node scripts/check-coverage-tiers.mjs`。**差分を推論しない**                                                                              |
| `transform` 削除がカバー済み行とそのテストを Tier 1(@90%、Tier 4 の次に厳しい)から同時に消す        | 3     | 同上。落ちたら revert でなく parser のエッジケーステストを追加                                                                                                   |
| `weighting.ts` をテストなしで置くと Tier 3 が「死」から「fail」へ                                   | 4     | 意図的かつ望ましい。ファイルとテストを同一コミットに                                                                                                             |
| テストが green になる前に `INTENTIONALLY_MOCKED` を削ると Tier 3 が約 0% で fail                    | 5     | テストを先に着地させ、削除は**同一 push 内の後続コミット**で                                                                                                     |
| 空の Tier が残ったまま "no files matched" をハード失敗にする                                        | 6     | 変更を当てた状態でスクリプトを 1 回実行。全 Tier のファイル数が出る                                                                                              |
| `quiz-runner.tsx` が 0% のまま Tier 4 を `/app/answer/**` に広げる                                  | 6     | Phase 4/5 完了が厳格な前提。パターン変更前に再計測                                                                                                               |
| 条件付き集約への書き換えが JST 日境界の意味論を静かに変える                                         | 7     | Phase 5 で**境界をまたぐ行**のケースを書いておく(そのために先に書く)                                                                                             |
| `create/page.tsx` の server/client 分割が E2E セレクタを壊す                                        | 7     | `pnpm test:e2e`。ここだけは E2E が主たる防護網                                                                                                                   |

---

## 検証(エンドツーエンド)

各 Phase の push 前に:

```
bash scripts/check-spec-refs.sh \
  && pnpm exec tsgo --noEmit \
  && pnpm lint:fast \
  && pnpm test:coverage && node scripts/check-coverage-tiers.mjs \
  && pnpm test:e2e
```

全 Phase 完了後の受け入れ確認:

1. `node scripts/check-coverage-tiers.mjs` が **6 Tier すべてで実ファイル数 > 0** を表示し、"No files matched" が 1 件もないこと
2. `pnpm dev` で手動確認 — `/create` で知識を投入 → `/answer` で解答 → `/` に本日の統計が反映される
3. `GET /api/questions/random` を意図的に 500 にして、UI に**空でない**エラーメッセージが出ること(statusText バグの回帰確認)
4. `GOOGLE_API_KEY` を外して `POST /api/questions` を叩き、「JSON パース失敗」ではなく**設定エラーとして区別されて**ログに出ること
5. `pnpm db:migrate` をクリーンな `:memory:` に適用できること(`tests/helpers/db.ts` が毎テストで実証)

---

## 変更対象の主要ファイル

| ファイル                                          | Phase     | 変更内容                                                                                       |
| ------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `src/lib/api/client.ts`                           | 3         | 3 ラッパー → `request()`、statusText 廃止、Zod レスポンス検証                                  |
| `src/lib/api/response.ts`                         | 3         | `withErrorHandling()` 追加                                                                     |
| `src/lib/llm/parser.ts`                           | 3         | retry tail 抽出、設定エラー再 throw、`transform` 削除                                          |
| `src/lib/db/repository/question-repository.ts`    | 4, 7      | 重み計算を抽出、カラム射影 + `Promise.all`                                                     |
| `src/lib/db/repository/weighting.ts`              | 4         | **新規** — 純粋な重み計算。Tier 3 を復活させる                                                 |
| `src/app/answer/choice-state.ts`                  | 4         | **新規** — 純粋な variant ステートマシン                                                       |
| `src/lib/db/schema.ts` + `src/lib/db/migrations/` | 2         | 冗長 index 削除、複合 index 追加、baseline 生成                                                |
| `scripts/check-coverage-tiers.mjs`                | 0, 6      | 恒等関数削除、空 Tier をハード失敗化、`lib/api` Tier 追加、Tier 4 を branches + 複数ファイル化 |
| `scripts/migrate.ts`                              | 2         | **削除**(破壊的 DROP)                                                                          |
| `openspec/specs/study/spec.md`                    | 2,3,4,6,7 | 各 Phase で同期。**テストセクションを新設**                                                    |
| `tests/helpers/`, `tests/fixtures/`               | 1, 2      | **新規** — 共有 helper と fixture                                                              |

---

# 実施結果（2026-08-06 時点: 全 Phase 完了）

## 完了コミット一覧

| Phase | コミット            | 内容                                                                                                                                                                                 | 検証                                                                            |
| ----- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 0     | `6f61ff3`           | 衛生作業（.eslintcache untrack、未使用依存削除、test:prod 等削除、@server エイリアス削除、config 修正、CI 強化: spec-refs / coverage tier / security-check 追加）                    | tsgo 0 / 82 unit / 28 e2e                                                       |
| 1     | `4c1c5b4` `5a57719` | テスト基盤整備（helpers/fixtures 新設、tests 型検査・lint 有効化、env helper 堅牢化）                                                                                                | tsgo 0 / 82 unit                                                                |
| 2     | `12d2760`           | 実マイグレーション化（冗長 index 削除、複合 index 追加、破壊的 migrate.ts 削除、db:migrate 追加）                                                                                    | tsgo 0 / 82 unit                                                                |
| 3     | `6073ce4` `592d280` | バグ修正 + 重複排除（client.ts 全面書き直し / statusText 廃止 / Zod 検証 / withErrorHandling / parser 修正 / createQuestion 活用）                                                   | tsgo 0 / 87 unit / 28 e2e / 全 Tier                                             |
| 4     | `3d68066` `4659a06` | 純粋ロジック抽出（weighting.ts / choice-state.ts、テスト同一コミット）→ **Tier 3 復活** 93.33%                                                                                       | tsgo 0 / 全 Tier                                                                |
| 5     | `b7f4a3b` `9ab9eb3` | リポジトリ / オーケストレーションのテスト、`INTENTIONALLY_MOCKED` 全削除、テスト用 DB をファイルベース一時 DB に移行                                                                 | tsgo 0 / 116 unit / 28 e2e / 全 Tier                                            |
| 6     | `de08459`           | カバレッジ Tier 実効化（空 Tier ハード失敗化、lib/api Tier 追加、Tier 4 を複数ファイル + branches ゲート化、schema.ts 除外）                                                         | tsgo 0 / 124 unit / 全 6 Tier PASS                                              |
| 7     | `42dea27`           | UI 重複排除 + 性能（cn.ts / Spinner 抽出、Button variant 再利用、QuestionCard デッドコード削除、クエリ射影 + Promise.all、条件付き集約、phaseRef、create ページ server/client 分割） | tsgo 0 / **136 unit** / 28 e2e / 全 6 Tier PASS（Tier4 94.44 + 90.00 branches） |

## フォローアップ: CI Security Check 失敗の修正（`44702ac`）

- **経緯**: Phase 7 の push（`42dea27`）で GitHub Actions の **Security Check** ステップが初めて実行され失敗（Phase 0 で CI に追加した `security-check` はそれ以前の push では未実行だったため顕在化していなかった）
- **原因 1（`pnpm audit` 3 high）**: `sharp@0.34.5`（next 16.2.12 optionalDeps 経由、patched ≥0.35.0）、`postcss@8.4.31`（next 16.2.12 deps 経由、patched ≥8.5.12）、`postcss@8.5.16`（直接依存、patched ≥8.5.18）
- **原因 2（`secretlint` exit 2）**: `.secretlintrc` 設定ファイルが存在せず、ルールパッケージも未導入（CI 追加時に潜伏していたバグ）
- **修正**:
  - `next` / `@next/bundle-analyzer` / `eslint-config-next` → `^16.3.0`（next 16.3.0 は postcss 8.5.23 + sharp `^0.35.3` を使用し、next 経由の 2 件が同時に解消）
  - `postcss` → `^8.5.25`（直接依存分）
  - `@secretlint/secretlint-rule-preset-recommend@^12.3.1` 追加 + `.secretlintrc` / `.secretlintignore` 新規作成
- **検証**: `pnpm security-check` exit 0（1 moderate のみ）/ tsgo 0 / lint OK / 136 unit / 28 e2e / CI run `31084890109` 全 12 ステップ green

## 最終状態（全 Phase 完了後）

- **unit 136 / 30 files、e2e 28/28、tsgo 0、lint:fast OK**
- カバレッジ 6 Tier 全 PASS: Tier1 95.83 / Tier2 97.10 / Tier2b 89.13 / Tier3 87.50 / Tier4 94.44 + 90.00 branches / Tier5 100.00
- 全 Phase のコミット・push 済み（main ブランチ）
- spec.md は各 Phase で同期済み（Testing セクション・Components・Data Model 注記含む）

---

# 独立検証（2026-08-06）

上記の自己申告を鵜呑みにせず、Phase 0〜7 の全 44 個の個別クレームを実ファイルに対して検証し、ゲートを実際に実行して数値クレームを再現した。

**結論: プランは実質的に完遂されている。** 44 クレーム中 38 が完全 DONE。ただし 5 件の未完了項目が残り、うち 1 件は**本プラン自身の受け入れ基準を満たしていない**（主目的だった本番バグの回帰テストが、実際にはバグを検出できない）。

## 再現できた数値クレーム

| クレーム             | 実測                                                                                                                                        | 判定 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| unit 136 / 30 files  | `136 passed (136)` / `30 passed (30)`                                                                                                       | ✅   |
| tsgo 0 エラー        | 出力なし                                                                                                                                    | ✅   |
| `check-spec-refs.sh` | `✅ All spec.md file references are valid`                                                                                                  | ✅   |
| 6 Tier 全 PASS       | Tier1 95.83 / Tier2 97.10 / Tier2b 89.13 / Tier3 87.50 / Tier4 94.44 + branches 90.00 / Tier5 100.00 → `✅ All tiers meet coverage targets` | ✅   |

Tier 3 は `INTENTIONALLY_MOCKED = []`（空、`scripts/check-coverage-tiers.mjs:26-28`）の状態で 87.50% を実測しており、**プランが狙った「死んだ Tier の復活」は本当に起きている**。"No files matched" のハード失敗化（`:127-136`）、Tier 2b @85%（`:49-54`）、Tier 4 の branches ゲート（`:61-67`、`:155-160` で実際に enforce）もすべて実装済み。

## 未コミット差分（是正不要）

- `next-env.d.ts` — Next.js 自動生成。`44702ac` の Next 16.3 昇格に伴う `.next/dev/types/` パス変更
- `src/components/NavLink.tsx` — 102 文字行の折り返しのみ。`cn(...)` の引数はバイト同一で意味変化ゼロ

どちらもプランの積み残しではない。

## 残課題

### 1. statusText バグの回帰テストが実際には回帰を検出できない ★最重要

受け入れ基準 3「UI に**空でない**エラーメッセージが出ること（statusText バグの回帰確認）」を守るテストが存在しない。`tests/api/client.test.ts` の該当アサーション 3 件中 2 件が空振りする:

- `:25-28` 非 JSON フォールバック — `await expect(...).rejects.toThrow()` に**メッセージ引数がない**。`res.statusText` に戻しても素通りする
- `:54-62` "createQuestion throws error body message" — `createQuestion` が `customErrorMsg = "生成に失敗しました"`（`src/lib/api/client.ts:120`）をハードコードしており、これがモックのボディと偶然一致するため、**ボディを一切読まなくても pass する偽陽性**

是正: 非 JSON ケースに具体的なメッセージ引数を渡す、`submitAnswer` のエラー経路を追加、`createQuestion` のテストはボディと異なる文字列を使って本当にどちらが出るか確定させる。

### 2. `createQuestion` のエラーボディが二重に握り潰されている

Phase 3 は「一度も消費されていない `{ error }` エラー契約を消費する」ことを目的にしたが、create 経路だけ 2 箇所で潰れている:

- `src/lib/api/client.ts:49` — `customErrorMsg ?? (await readErrorMessage(...))` の短絡で、`createQuestion` はサーバのボディを読まない
- `src/app/create/create-form.tsx:25-27` — `catch {` がエラーを束縛せず `setError("生成に失敗しました")` を固定表示

結果として `/create` のエラー表示は Phase 3 以前と実質同じ。`customErrorMsg` をフォールバック側に降格し、`create-form.tsx` を `errorMessage()` 経由にする。

### 3. `errorMessage()` ヘルパーが create ページに未適用（Phase 7 の積み残し）

`src/lib/error-message.ts` は存在し `use-quiz-session.ts:51,83` で使われているが、Phase 7 が名指しした 3 つ目の呼び出し元 `create/page.tsx`（現 `create-form.tsx`）には未適用。課題 2 と同一の修正で解消する。

### 4. `lint:fast` が tests/ を除外し続けており、Phase 1 の lint 有効化が CI で無効

`tsconfig.json:35` の `exclude` からは `tests/**` が外れており**型検査は有効**。しかし:

- `package.json:17` — `"lint:fast": "oxlint --ignore-pattern 'tests/**' ..."`
- `.github/workflows/main.yml:34` — CI が実行するのは `lint` ではなく `lint:fast`

Phase 1 の「tests/ の型検査・lint 有効化」は**型検査の半分しか効いていない**。

### 5. 小さな一貫性の綻び

- `src/components/ChoiceButton.tsx:3` が `ChoiceVariant` union を宣言しており `src/app/answer/choice-state.ts:1` の逐語コピー。Phase 4 でステートマシンは抽出したが型は 2 箇所に残り黙って乖離しうる
- `src/lib/api/response.ts:12,15` の `context?: any` — `src/` 唯一の `any` で `openspec/config.yaml:35`「any 禁止」に違反
- `src/app/api/stats/` が route ファイルのない空ディレクトリ
- `tests/` 7 ファイルに `vi.clearAllMocks()` / `vi.restoreAllMocks()` の個別呼び出しが残存（`tests/setup.ts:4-6` のグローバル `afterEach` があるため冗長）。Phase 1 が削除を指示していた分
  - `tests/llm/parser.test.ts:15`, `tests/llm/client.test.ts:28`, `tests/api/questions.test.ts:16`, `tests/api/answers.test.ts:18`, `tests/api/questions-random.test.ts:11`, `tests/answer/use-quiz-session.test.tsx:13`, `tests/api/client.test.ts:6`

## 是正の変更対象

| ファイル                               | 課題 | 変更内容                                                         |
| -------------------------------------- | ---- | ---------------------------------------------------------------- |
| `tests/api/client.test.ts`             | 1    | 空振りアサーション 2 件を実効化、`submitAnswer` エラー経路を追加 |
| `src/lib/api/client.ts:49,120`         | 2    | `customErrorMsg` をボディ読み取りの**フォールバック**に降格      |
| `src/app/create/create-form.tsx:25-27` | 2, 3 | `catch (e)` で束縛し `errorMessage(e)` を使用                    |
| `package.json:17`                      | 4    | `lint:fast` から `--ignore-pattern 'tests/**'` を削除            |
| `src/components/ChoiceButton.tsx:3`    | 5    | `ChoiceVariant` を `@/app/answer/choice-state` から import       |
| `src/lib/api/response.ts:12,15`        | 5    | `any` → `unknown`                                                |
| `src/app/api/stats/`                   | 5    | 空ディレクトリ削除                                               |
| `tests/` 7 ファイル                    | 5    | 個別 `clearAllMocks` / `restoreAllMocks` を削除                  |

再利用する既存資産: `src/lib/error-message.ts`（新規作成しない）、`src/lib/api/client.ts:27` の `readErrorMessage`、`tests/helpers/fetch.ts` の `mockFetch` / `jsonResponse`。

**push 粒度**: 全課題を 1 push にまとめる。コミットは論理単位で分割。`src/` を触るためカバレッジゲートは発火する。課題 1・2 は Tier 2b @85%（現在 89.13%、**マージン 4.13pt**）に着地するので、`client.ts:50,57,62,84,89` の未カバー行がテスト追加で埋まる方向。差分は推論せず計測する。

## 是正の検証

```
bash scripts/check-spec-refs.sh \
  && pnpm exec tsgo --noEmit \
  && pnpm lint:fast \
  && pnpm test:coverage && node scripts/check-coverage-tiers.mjs \
  && pnpm test:e2e
```

加えて、課題 1 が本当に効いていることの確認:

1. `src/lib/api/client.ts` を一時的に `res.statusText` 使用へ戻し、`tests/api/client.test.ts` が**赤くなる**ことを確認してから元に戻す（現状は緑のまま通ってしまう）
2. `GOOGLE_API_KEY` を外して `/create` から生成 → 画面に固定文言ではなくサーバ由来のメッセージが出ること
3. `pnpm lint:fast` が tests/ を走査した上で 0 件になること

---

# 是正の実施結果（2026-08-06）

上記 5 残課題の是正を実施し、コミットは論理単位で分割、push は 1 回。

## 完了コミット一覧

| コミット  | 内容                                                                                                                                                                 | 検証                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `e74856e` | 課題2/3: `client.ts` の `readErrorMessage` を `string \| null` 化し `customErrorMsg` をフォールバックに降格、`create-form.tsx` を `errorMessage(e, ...)` 経由に      | tsgo 0 / 139 unit                          |
| `7313753` | 課題1: 非JSON fallback に具体的メッセージ、createQuestion をボディ別文言で検証、submitAnswer エラー経路 + 非JSON fallback 追加、E2E をサーバ由来メッセージ表示に更新 | 全 Tier PASS（Tier2b 89.13→91.30）/ 28 e2e |
| `1a0dc08` | 課題5: 6 テストファイルの個別 mock クリーンアップ削除 + `tests/setup.ts` に `vi.clearAllMocks()` 追加                                                                | 139 unit PASS                              |
| `032b1d0` | 課題4: `lint:fast` から `--ignore-pattern 'tests/**'` を削除                                                                                                         | lint:fast 0 件                             |
| `cf0f726` | 課題5: `ChoiceButton.tsx` の `ChoiceVariant` を `choice-state` から import、`response.ts` の `any`→`unknown`、空 `src/app/api/stats/` 削除                           | tsgo 0                                     |
| `b12c62e` | 本セクション（是正の実施結果）の追記                                                                                                                                 | —                                          |

## 是正の要点

- **課題1（statusText 回帰テスト実効化）**: 検証手順どおり、`client.ts` を一時的に `res.statusText` 使用へ戻して `tests/api/client.test.ts` が**赤くなる**ことを確認済み（`'Failed to fetch random question: '` と空になる）→ 復元。また `createQuestion` テストはボディを `"サーバで問題が発生しました"` に変え、固定文言 `"生成に失敗しました"` との偽陽性一致を排除した。
- **課題2（エラーボディ二重握り潰し）**: `readErrorMessage` が `null` を返せるようになり、`request()` は `readErrorMessage(res) ?? customErrorMsg ?? fallback` の順で評価。`createQuestion` はサーバボディを読む。`create-form.tsx` は `catch (e) { setError(errorMessage(e, "生成に失敗しました")); }`。
- **課題4（lint:fast）**: `--ignore-pattern 'tests/**'` を削除し、CI が実行する `lint:fast` が tests/ を走査するようになった。検証手順 3 のとおり 0 件。
- **課題5（mock クリーンアップの補足）**: `vi.restoreAllMocks()` は module レベルの `vi.fn()` の呼び出し履歴を**リセットしない**ため、個別クリーンアップ削除だけでは `toHaveBeenCalledTimes` 系 10 テストが失敗した。正解はグローバル `tests/setup.ts` に `vi.clearAllMocks()` を追加すること。これにより個別呼び出しは真に冗長となり、削除が安全になる（139 unit で確認）。

## 最終状態

- **unit 139 / 30 files、e2e 28/28、tsgo 0、lint:fast 0 件**
- カバレッジ 6 Tier 全 PASS: Tier1 95.83 / Tier2 97.10 / Tier2b 91.30 / Tier3 87.50 / Tier4 94.44 + 90.00 branches / Tier5 100.00
- spec.md は変更なし（テスト/カバレッジセクション・ファイル参照に影響なし）

---

# 第二次独立検証（2026-08-06）

上記「独立検証」と「是正の実施結果」の自己申告を再び鵜呑みにせず、全ゲートを実行して数値を再現し、コードクレームを実ファイルに突き合わせた。

**結論: 実装は正しい。** 数値クレーム 11 項目すべてが誤差ゼロで再現し、コードクレームも全件が実ファイルと一致した。ただし本文書（自己申告・第一次独立検証の両方）が**見落としていた事柄が 3 件**あり、以下に記録する。

## 再現できた数値クレーム（誤差ゼロ）

| クレーム             | 実測                                                           | 判定 |
| -------------------- | -------------------------------------------------------------- | ---- |
| unit 139 / 30 files  | `139 passed (139)` / `30 passed (30)`                          | ✅   |
| tsgo 0 エラー        | 出力なし、exit 0                                               | ✅   |
| lint:fast 0 件       | `Found 0 warnings and 0 errors.`（93 files / 136 rules 走査）  | ✅   |
| e2e 28/28            | `28 passed (25.8s)`（chromium + Mobile Chrome、14 unique × 2） | ✅   |
| `check-spec-refs.sh` | `✅ All spec.md file references are valid`                     | ✅   |
| Tier1 95.83          | 95.83% (46/48 statements)                                      | ✅   |
| Tier2 97.10          | 97.10% (67/69)                                                 | ✅   |
| Tier2b 91.30         | 91.30% (42/46)                                                 | ✅   |
| Tier3 87.50          | 87.50% (49/56)                                                 | ✅   |
| Tier4 94.44 + br     | 94.44% (85/90) + branches 90.00% (54/60)                       | ✅   |
| Tier5 100.00         | 100.00% (25/25)                                                | ✅   |

`INTENTIONALLY_MOCKED = []`（空）の状態で全 6 Tier が実ファイル 3〜9 本を集計して PASS し、"No files matched" は **1 件もない**。Phase 6 の「死んだ Tier の復活」は実測で裏付けられた。

コード側も全件一致: `statusText` は repo 全体で **0 hit** / `src/` の `any` も **0 hit**（`prompts.ts:7` の英文 "any position" のみ）/ `scripts/migrate.ts` 削除済み / `src/lib/db/migrations/` に実マイグレーションあり（`schema.ts` と**ドリフトなし**、`desc()` 順序まで一致）/ `ChoiceVariant` は `choice-state` から import / `src/app/api/stats/` 削除済み / `tests/` の個別 mock クリーンアップは **0 件**（`tests/setup.ts:4-7` のグローバル `afterEach` のみ）。

> 「6 ファイル削除」と「7 ファイル」の食い違いは記録上のズレのみ。`tests/api/client.test.ts` の分は 1 コミット前の `7313753` で既に削除されており、末端状態は 7 ファイルすべて clean。

## 見落とされていた 3 件

### 課題A — 課題2（エラーボディ優先）を守るテストが実質 1 本しかない ★最重要

`tests/api/client.test.ts` の 9 テストのうち、旧バグ `customErrorMsg ?? (await readErrorMessage(res))` に戻したとき**赤くなるのは `:67-75` の 1 本だけ**。構造的な理由:

- `:11-19`（fetchRandomQuestion）と `:52-60`（submitAnswer）は「ボディが勝つ」テストに見えるが、**両呼び出し元が `customErrorMsg` を渡さない**（`client.ts:76` / `:98-107`）。旧実装でも `undefined ?? body` で同じ結果になり**素通りする**
- `:77-82`（非 JSON → `"生成に失敗しました"`）も旧実装と同一結果 → **優先順位に対して空振り**

つまり `:67-75` を消すと課題2 のバグが無言で復活できる。「エラーボディ経路のテストを 3 本足した」という記録は本数としては正しいが、**優先順位バグに対する実効本数は 1 本**である。

> statusText 回帰の防護自体は健全。`:21-26` と `:62-65` が `statusText` 未設定の `Response`（= HTTP/2 と同じ空文字条件）に対し `"status 502"` を literal で要求しているため、`statusText` へ戻すと確実に赤くなる。「一時的に戻して赤を確認した」という記録と整合する。

### 課題B — Phase 3 の「3 ラッパー → 単一 `request()` に集約」は 2/3 しか達成されていない

`fetchRandomQuestion`（`src/lib/api/client.ts:68-92`）は `request()` を使わず、エラー処理（`:74-78`）とパース + schema 検証（`:80-91`）を `request()` 内部（`:47-65`）と**逐語で重複**させている。404 → `null` の特別扱いが理由だが、`request()` にオプションを足せば吸収できる。

副作用としてメッセージが不統一: `request()` の `Failed to parse response from ${label}` / `Invalid response schema for ${label}: ${詳細}` に対し、`fetchRandomQuestion` は `"Unexpected response"` / `"Invalid response schema"`（`:84`, `:89`）と情報量が落ちる。**この 4 行（`:57`, `:62`, `:84`, `:89`）が Tier 2b の唯一の未カバー箇所**でもある。

### 課題C — ESLint がどこでも実行されていない

課題4 で `lint:fast` から `--ignore-pattern 'tests/**'` は外れた。しかし `.github/workflows/main.yml:33-34` も `.husky/pre-commit:4` も実行するのは `lint:fast`（oxlint）のみで、`package.json:16` の `"lint": "eslint --cache"` と `eslint.config.mjs` には**自動実行経路が 1 つもない**。Phase 1 の「tests/ の lint 有効化」は oxlint 側では達成されているが、eslint 側はそもそも死んでいた。

→ **oxlint 一本化（ESLint 撤去）で解消する**方針を採用。

## 未コミット差分の再評価（第一次検証の「是正不要」を一部訂正）

- `src/components/NavLink.tsx` — oxfmt の行折り返しのみ。**是正不要で正しい**
- `next-env.d.ts` — `./.next/types/` → `./.next/dev/types/` + `root-params.d.ts` 追加。Next 16.3 昇格に伴う自動生成物だが、**`tsgo --noEmit` にとって load-bearing**。`.next/dev/types/` が未生成のクリーンな clone では未解決モジュールで型検査が落ちる。「是正不要」ではなく **コミットすべき**
- `AGENTS.md` — 本検証で e2e を実行した際、`next dev` が `<!-- BEGIN:nextjs-agent-rules -->` ブロックを自動追記した（`node_modules/next/dist/server/lib/generate-agent-files.js`）。検証前は clean だった**検証実行の副作用**。消しても `next dev` のたびに再生成されるため**コミットする**

## CI の現状（記録）

`.github/workflows/main.yml` が実行するのは type-check:fast / lint:fast / test:all / check-spec-refs.sh / test:coverage + check-coverage-tiers.mjs / security-check / build。**e2e は CI に入っていない**（Phase 0 の「E2E は CI に入れない」という判断どおりで、意図的）。

---

# 第三次実施結果（2026-08-06）

第二次独立検証で見つかった 3 件（課題A・課題B・課題C）と未コミット差分の是正を実施。コミットは論理単位で分割、push は 1 回。

## 完了コミット一覧

| コミット  | 内容                                                                                                                                                     | 検証                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `3cc6f76` | 課題B+A: `fetchRandomQuestion` を `request()` に統合（`allowNotFound` オプション）、createQuestion のエラーボディ優先を `it.each` テーブルで多重防護     | tsgo 0 / **141 unit** / 全 Tier PASS |
| `d5b6cab` | 課題C: ESLint 完全撤去（oxlint 一本化）— `lint` スクリプト・devDeps 4 件・`eslint.config.mjs` 削除、lint-staged / openspec/config.yaml / .gitignore 整理 | lint:fast 0 件 / tsgo 0              |
| `51e57d7` | 未コミット差分の取り込み: `next-env.d.ts` / `AGENTS.md` / `NavLink.tsx`                                                                                  | —                                    |
| `952b3a9` | 本セクション（第三次実施結果）の追記                                                                                                                     | —                                    |
| `30cb16a` | 本セクションの追記コミットハッシュの記録                                                                                                                 | —                                    |
| `3acad7c` | oxfmt 整形の適用（markdown テーブル幅・`it.each` 配列の折り返し）                                                                                        | —                                    |

## 是正の要点

- **課題A（エラーボディ優先の回帰防護を多重化）**: `createQuestion` のボディ別文言テストを `it.each` テーブル（2 行: `データベースエラーが発生しました` / `LLM の応答が不正です`）で追加。旧バグ `customErrorMsg ?? body` に戻したとき赤くなるテストが **1 本 → 3 本** に増加（`createQuestion throws error body message` + テーブル 2 行）。全てボディ文言を `生成に失敗しました` と異ならせ、偽陽性を排除。
- **課題B（3 ラッパー → 単一 `request()` の完全達成）**: `fetchRandomQuestion`（`client.ts:68-92`）を `request()` 経由に変更。`RequestOptions { customErrorMsg?, allowNotFound? }` を導入し、404→null は `allowNotFound: true` で吸収。`request()` は `readErrorMessage(res) ?? options?.customErrorMsg ?? fallback` の順で評価を維持。メッセージも統一され、情報量の落ちていた `"Unexpected response"` / `"Invalid response schema"`（`:84, :89`）を撤去。
  - 副産物: **Tier 2b が 91.30% → 94.29%**（`client.ts` 61% → 92.3%）。重複行 2 本（旧 `:84, :89`）が消え、残る未カバーは `request()` のパース/スキーマエラー 2 行のみ（`:62, :67`）。
- **課題C（ESLint 撤去・oxlint 一本化）**: `pnpm lint`（eslint）は CI（`.github/workflows/main.yml:34`）・husky（`.husky/pre-commit:4`）のどちらからも参照されていなかったため、撤去しても workflow / hook の変更は不要。`eslint.config.mjs` 削除 + devDeps 4 件（eslint / eslint-config-next / eslint-plugin-react / eslint-plugin-react-hooks）削除 + `package.json:16` の `lint` スクリプト削除。あわせて `lint-staged.config.js:1` の eslint ディレクティブ、`openspec/config.yaml:13`、`.gitignore:39` の `.eslintcache` を整理。`pnpm-lock.yaml` から eslint は完全消滅。
  - `src/app/answer/use-quiz-session.ts:90` の `// eslint-disable-next-line react-hooks/set-state-in-effect` は oxlint が eslint-disable ディレクティブを解釈するため**残置**（`lint:fast` 0 件で確認済み）。
- **未コミット差分**: 第二次独立検証の結論どおり、`next-env.d.ts`（`.next/dev/types/` パス、tsgo に load-bearing）と `AGENTS.md`（next dev の自動生成ブロック）をコミット。`NavLink.tsx` は oxfmt の行折り返しのみで意味変化ゼロのためそのまま取り込み。

## 検証（全ゲート実測）

```
bash scripts/check-spec-refs.sh        ✅ All spec.md file references are valid
pnpm exec tsgo --noEmit                ✅ 0 errors
pnpm lint:fast                         ✅ 0 warnings / 0 errors
pnpm test:coverage                     ✅ 141 passed (30 files)
node scripts/check-coverage-tiers.mjs  ✅ 全 6 Tier PASS（Tier2b 94.29% = 33/35）
pnpm test:e2e                          ✅ 28 passed
```

他 Tier は据え置き: Tier1 95.83 / Tier2 97.10 / Tier3 87.50 / Tier4 94.44 + branches 90.00 / Tier5 100.00。

## 最終状態

- **unit 141 / 30 files、e2e 28/28、tsgo 0、lint:fast 0 件**
- カバレッジ 6 Tier 全 PASS（Tier2b のみ 91.30 → **94.29** に向上）
- spec.md は変更なし（`check-spec-refs.sh` は 8 件の参照を全て維持、テスト/カバレッジセクションへの影響なし）

---

# 第三次独立検証（2026-08-06）

第三次実施結果（課題A/B/C と未コミット差分の取り込み）を実ファイルに突き合わせて検証した。HEAD = `5865b98`、tracked tree は clean（未追跡は `.claude/summaries/*.md` のみ）。

## 結論

第三次実施結果の 4 項目のうち、**課題A と `51e57d7` は記載どおり**。**課題B・課題C は達成しているが、記述に誤り／未記載の副作用が計 3 件**ある。

| 項目                        | 判定 | 要点                                                       |
| --------------------------- | ---- | ---------------------------------------------------------- |
| 課題A（回帰防護 1→3 本）    | ✅   | 記載どおり。実効 3 本・偽陽性なしを 11 ケース個別に確認    |
| 課題B（`request()` 統合）   | ⚠️   | 統合は達成。ただし `as` cast による型安全の穴を 2 箇所新設 |
| 課題C（ESLint 撤去）        | ⚠️   | 撤去は完全。ただし :545 の「残置理由」の記述が事実と異なる |
| `51e57d7`（未コミット差分） | ✅   | 記載どおり。全て committed・clean                          |

## 課題A — ✅ 記載どおり

`tests/api/client.test.ts` の全 11 ケース（`it` 9 個 + `it.each` 2 行）を旧バグ順 `customErrorMsg ?? (await readErrorMessage(res))` に戻した場合に赤くなるかを個別判定した。

- `customErrorMsg` を渡すのは `createQuestion` のみ（`client.ts:110`）。他 7 ケースは構造上バグを検出し得ない。
- `:77`（非 JSON → `生成に失敗しました`）は `readErrorMessage` が `null` を返すため両実装で同結果 = 検出せず。
- **検出 3 本**: `:67`（body `サーバで問題が発生しました`）、`:84` の 2 行（`データベースエラーが発生しました` / `LLM の応答が不正です`）。
- 3 本の body 文言は全て fallback `生成に失敗しました` と別文字列で、`rejects.toThrow(string)` の部分一致でも取り違えなし → 偽陽性なしの主張も正しい。

「1 本 → 3 本」は正確。139 + 2 = 141 も算術的に整合。

## 課題B — ⚠️ 統合は達成、ただし未記載の型安全リグレッション

達成確認点（実ファイル一致）:

- `fetchRandomQuestion`（`client.ts:73-82`）は `request()` 経由。手書きのエラー処理・パース・schema 検証は消滅。
- `RequestOptions { customErrorMsg?, allowNotFound? }` は `client.ts:27`。404→null は `client.ts:49-51` で `!res.ok` 判定より前に処理し旧セマンティクスを保持。
- 優先順位 `readErrorMessage(res) ?? options?.customErrorMsg ?? fallback` は `client.ts:54` に維持。
- `"Unexpected response"` / `"Invalid response schema"` は `src/` から消滅。
- `fetch("/api...)` の直接呼び出しは `client.ts:48`（`request()` 内部）の 1 箇所のみ。3/3 ラッパーが `request()` 経由。

**未記載の問題（主要な発見）**: `request<T>` の戻り値が `Promise<T>` → `Promise<T | null>` に広がった（`client.ts:47`）。`null` を返し得るのは `allowNotFound: true` の時だけなのに、型は全呼び出し元に `| null` を伝播させる。その結果、非 null の 2 呼び出し元が **本コミットで新設された unsound な cast** で握り潰している:

```ts
client.ts:97   return (await request(...)) as AnswerResult;
client.ts:111  return (await request(...)) as CreatedQuestion;
```

このコミット以前は存在しなかった型の穴で、「`src/` の `any` 0 hit」を成果として掲げてきた本計画の方針と不整合。`as` は `any` と違い tsgo にも oxlint にも掛からず、どのゲートも検出しない。

## 課題C — ⚠️ 撤去は完全、ただし :545 の記述が誤り

撤去の機械的完全性（確認済み）:

- `eslint.config.mjs` 不在（tracked にも disk にもなし）
- `package.json` に `lint` スクリプトなし。残るのは `lint:fast` / `format:fast` / `security-check`
- devDependencies に `eslint*` が 0 件
- `pnpm-lock.yaml` の `eslint` grep が完全に 0 hit
- `lint-staged.config.js` は `vitest related --passWithNoTests` のみの 3 行
- `openspec/config.yaml:13` は `Oxlint, Oxfmt, Prettier`、`.gitignore` から `.eslintcache` 削除済み
- CI・husky は `lint:fast` のみで実行経路の破壊ゼロ

**誤りが 1 件（:545）**: 「`use-quiz-session.ts:90` の `// eslint-disable-next-line react-hooks/set-state-in-effect` は oxlint が eslint-disable ディレクティブを解釈するため残置」という記述は、このディレクティブが**何も抑制していない no-op** である点で誤り。

- oxlint 1.76 に `react-hooks/set-state-in-effect` というルールは存在しない（native の react-hooks ルールは `exhaustive-deps` と `rules-of-hooks` の 2 つのみ。setState-in-effect の検査は react-compiler crate 内にあり lint ルールとして未露出）。
- `lint:fast` は `--react-hooks-plugin` を有効化していない。
- repo に oxlint 設定ファイル（`.oxlintrc.json` 等）は存在しない。
- 実証: `oxlint <same flags> --report-unused-disable-directives src/app/answer/use-quiz-session.ts` → `90:5: warning: Unused eslint-disable directive (no problems were reported).`

「`lint:fast` 0 件で確認済み」という根拠も無効。`--report-unused-disable-directives` が付いていないので、0 件は「他に何も出ていない」ことしか示さない。

**加えて `d5b6cab` が取りこぼしたドキュメント**:

- `README.md:20` — `- **Tooling**: pnpm, ESLint, Prettier`
- `IMPLEMENTATION.md:10, 32, 89, 255` — `eslint.config.mjs` を現存ファイルとして記載、構成表にも ESLint
- `openspec/specs/study/spec.md` には eslint 参照なし（spec 側は無傷）

## `51e57d7`（未コミット差分の取り込み）— ✅ 記載どおり

- `next-env.d.ts:3-4` が `./.next/dev/types/routes.d.ts` と `./.next/dev/types/root-params.d.ts` を import
- `AGENTS.md:32-40` に `<!-- BEGIN:nextjs-agent-rules -->` ブロック
- 3 ファイルとも committed・clean

## 是正方針

下記 1〜3 を実施する:

1. `request()` の戻り値型を overload で健全化（`as` cast 2 箇所を削除）
2. dead な eslint-disable ディレクティブを平文コメント化
3. ドキュメント（README / IMPLEMENTATION）の ESLint 記述を除去

実施後にゲート実測値を追記する。

---

# 第三次独立検証の是正（2026-08-06）

第三次独立検証で見つかった 3 件（型安全リグレッション / dead ディレクティブ / ドキュメント取りこぼし）の是正を実施。コミットは論理単位で分割、push は 1 回。

## 完了コミット一覧

| コミット  | 内容                                                                                 | 検証                                      |
| --------- | ------------------------------------------------------------------------------------ | ----------------------------------------- |
| `94e4657` | 第三次独立検証セクションの追記（検証結果の記録）                                     | —                                         |
| `4e17464` | 型是正: `request()` を overload 化し `as AnswerResult` / `as CreatedQuestion` を削除 | tsgo 0 / 141 unit / 全 Tier PASS          |
| `3e691b9` | ディレクティブ: dead な eslint-disable を平文コメント化                              | lint:fast 0 件（unused-disable 警告ゼロ） |
| `cc567ef` | ドキュメント: README / IMPLEMENTATION の ESLint・`eslint.config.mjs` 記述を除去      | —                                         |
| `f371364` | 本セクション（第三次独立検証の是正）の追記                                           | —                                         |

## 是正の要点

- **型安全リグレッション（`request()` overload 化）**: `request<T>` の戻り値が `Promise<T>` → `Promise<T | null>` に広がったことで新設された unsound な `as` cast 2 箇所（旧 `client.ts:97`, `:111`）を、関数 overload で解消。`allowNotFound: true` のときのみ `Promise<T | null>`、それ以外は `Promise<T>` を返すよう型で表現。`submitAnswer` / `createQuestion` は cast なしの `return request(...)` に、`fetchRandomQuestion` は `T | null` のまま。実装本体は無変更。
- **dead ディレクティブ**: `use-quiz-session.ts:90` の `// eslint-disable-next-line react-hooks/set-state-in-effect`（oxlint に存在しないルールの no-op）を平文コメント（`mountedRef` による保護の意図）に置換。`--report-unused-disable-directives` 付きで警告ゼロを確認。
- **ドキュメント取りこぼし**: `README.md:20` を `pnpm, Oxlint, Prettier` に、`IMPLEMENTATION.md:10,32,89,255` の ESLint / `eslint.config.mjs` 記述を除去。`shared_plan/*.md` と `PLAN.md` は歴史的記録として対象外。

## 検証（全ゲート実測）

```
bash scripts/check-spec-refs.sh        ✅ All spec.md file references are valid
pnpm exec tsgo --noEmit                ✅ 0 errors
pnpm lint:fast                         ✅ 0 warnings / 0 errors
pnpm lint:fast --report-unused-disable-directives  ✅ 警告ゼロ
pnpm test:coverage                     ✅ 141 passed (30 files)
node scripts/check-coverage-tiers.mjs  ✅ 全 6 Tier PASS（Tier2b 94.29% = 33/35）
pnpm test:e2e                          ✅ 28 passed
```

## 回帰防護の実証（課題A）

`client.ts:68` を一時的に旧バグ順 `options?.customErrorMsg ?? (await readErrorMessage(res)) ?? fallback` へ戻し、`pnpm vitest run tests/api/client.test.ts` を実行 → **PASS 8 / FAIL 3**。想定どおり 3 本（`createQuestion throws error body message` + `it.each` 2 行）が赤くなり、復元後に全 green を確認。

## 最終状態

- **unit 141 / 30 files、e2e 28/28、tsgo 0、lint:fast 0 件**
- カバレッジ 6 Tier 全 PASS（Tier2b 94.29%）
- `client.ts` の `as` cast は 0 件（overload 化で解消。`src/lib/db/index.ts:32` の既存 cast は本件とは無関係で残置）
