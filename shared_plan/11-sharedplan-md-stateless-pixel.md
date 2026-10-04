# 第三次実施結果の検証 — 結果と是正案

## Context

対象: `shared_plan/sharedplan-md-functional-crane.md` の最新セクション **「第三次実施結果（2026-08-06）」（:524-565）** のみ。
すなわち第二次独立検証で挙がった **課題A / 課題B / 課題C** と、未コミット差分の取り込み（`51e57d7`）の実装が、記載どおりに達成されているかを実ファイルに突き合わせて検証した。それ以前の Phase 0-7 や第一次・第二次検証は対象外。

HEAD = `5865b98`、tracked tree は clean（未追跡は `.claude/summaries/*.md` のみ）。

---

## 検証結果サマリ

| 項目                        | 判定 | 要点                                                           |
| --------------------------- | ---- | -------------------------------------------------------------- |
| 課題A（回帰防護 1→3 本）    | ✅   | 記載どおり。実効 3 本・偽陽性なしを 11 ケース個別に確認        |
| 課題B（`request()` 統合）   | ⚠️   | 統合自体は達成。ただし **新たに型安全の穴を 2 箇所作った**     |
| 課題C（ESLint 撤去）        | ⚠️   | 撤去は完全。ただし **:545 の「残置理由」の記述が事実と異なる** |
| `51e57d7`（未コミット差分） | ✅   | 記載どおり。全て committed・clean                              |
| 実測数値（:548-557）        | —    | plan mode のため未実行。141 は算術的に整合                     |

---

## 課題A — ✅ 記載どおり（訂正なし）

`tests/api/client.test.ts` の全 11 ケース（`it` 9 個 + `:84` の `it.each` 2 行）について、旧バグ `customErrorMsg ?? (await readErrorMessage(res))` に戻した場合に赤くなるかを個別に判定した。

- `customErrorMsg` を渡すのは `createQuestion` のみ（`src/lib/api/client.ts:110`）。よって他 7 ケースは構造上バグを検出し得ない — これは第二次検証の指摘どおり。
- `:77`（非 JSON → `生成に失敗しました`）は `readErrorMessage` が `null` を返すため両実装で同結果 = 検出せず。これも正しく「優先順位テストではない」と扱われている。
- **検出する 3 本**: `:67`（body `サーバで問題が発生しました`）、`:84` の 2 行（`データベースエラーが発生しました` / `LLM の応答が不正です`）。
- 3 本の body 文言はいずれも fallback `生成に失敗しました` と別文字列で、`rejects.toThrow(string)` の部分一致でも取り違えは起きない → **偽陽性なしの主張も正しい**。

**「1 本 → 3 本」は正確。** 139 + 2（`it.each` 2 行）= 141 も算術的に整合。

## 課題B — ⚠️ 統合は達成、ただし未記載の型安全リグレッションあり

達成が確認できた点（すべて実ファイルで一致）:

- `fetchRandomQuestion`（`client.ts:73-82`）は `request()` 経由に変更済み。手書きのエラー処理・パース・schema 検証は消滅。
- `RequestOptions { customErrorMsg?, allowNotFound? }` は `client.ts:27`。404→null は `client.ts:49-51` で `!res.ok` 判定より前に処理し旧セマンティクスを保持。
- 優先順位 `readErrorMessage(res) ?? options?.customErrorMsg ?? fallback` は `client.ts:54` に維持。
- `"Unexpected response"` / `"Invalid response schema"`（情報量の落ちた版）は `src/` から消滅。残る `client.ts:67` は詳細付きの `Invalid response schema for ${label}: ${parsed.error.message}`。
- `fetch("/api...)` の直接呼び出しは repo 全体で `client.ts:48`（`request()` 内部）の 1 箇所のみ。3/3 のラッパーが `request()` 経由。

**未記載の問題（本検証の主要な発見）:**

`request<T>` の戻り値が `Promise<T>` → `Promise<T | null>` に広がった（`client.ts:47`）。`null` を返し得るのは `allowNotFound: true` の時だけなのに、型は全呼び出し元に `| null` を伝播させる。その結果、非 null の 2 呼び出し元が **本コミットで新設された unsound な cast** で握り潰している:

```ts
client.ts:88-97   return (await request(...)) as AnswerResult;
client.ts:101-111 return (await request(...)) as CreatedQuestion;
```

このコミット以前は存在しなかった型の穴で、「`src/` の `any` 0 hit」を成果として掲げてきた本計画の方針と整合しない。`as` は `any` と違って lint にも tsgo にも引っかからないため、どのゲートでも検出されない。

## 課題C — ⚠️ 撤去は完全、ただし :545 の記述が誤り

撤去の機械的な部分は全て確認できた:

- `eslint.config.mjs` 不在（tracked にも disk にもなし）
- `package.json` に `lint` スクリプトなし。残るのは `lint:fast`（`oxlint --nextjs-plugin --react-plugin --react-perf-plugin`）/ `format:fast` / `security-check`
- devDependencies に `eslint*` が **0 件**
- `pnpm-lock.yaml` の `eslint` grep が **完全に 0 hit**（「完全消滅」は文字どおり正しい）
- `lint-staged.config.js` は `vitest related --passWithNoTests` のみの 3 行
- `openspec/config.yaml:13` は `Oxlint, Oxfmt, Prettier`、`.gitignore` から `.eslintcache` 削除済み
- `.github/workflows/main.yml:33-34` と `.husky/pre-commit:4` は `lint:fast` のみ。`.husky/pre-push` に lint 呼び出しなし。`scripts/` にも参照なし → **実行経路の破壊はゼロ**

**誤りが 1 件（:545）:**

> `src/app/answer/use-quiz-session.ts:90` の `// eslint-disable-next-line react-hooks/set-state-in-effect` は oxlint が eslint-disable ディレクティブを解釈するため**残置**（`lint:fast` 0 件で確認済み）。

このディレクティブは **何も抑制していない no-op**:

- oxlint 1.76 に `react-hooks/set-state-in-effect` というルールは存在しない（native の react-hooks ルールは `exhaustive-deps` と `rules-of-hooks` の 2 つのみ。setState-in-effect の検査は react-compiler crate 内にあり lint ルールとして露出していない）
- そもそも `lint:fast` は `--react-hooks-plugin` を有効化していない
- repo に oxlint 設定ファイル（`.oxlintrc.json` 等）は存在せず、CLI フラグ + デフォルトのみで動作
- 実証: `oxlint <same flags> --report-unused-disable-directives src/app/answer/use-quiz-session.ts` →
  `90:5: warning: Unused eslint-disable directive (no problems were reported).`

「`lint:fast` 0 件で確認済み」という根拠も無効。`--report-unused-disable-directives` が付いていないので、0 件は「他に何も出ていない」ことしか示さない。

**加えて `d5b6cab` が取りこぼしたドキュメント:**

- `README.md:20` — `- **Tooling**: pnpm, ESLint, Prettier`
- `IMPLEMENTATION.md:10, 32, 89, 255` — `eslint.config.mjs` を現存ファイルとして記載、構成表にも ESLint
  （`openspec/specs/study/spec.md` には eslint 参照なし = spec 側は無傷）

## `51e57d7`（未コミット差分の取り込み）— ✅ 記載どおり

- `next-env.d.ts:3-4` が `./.next/dev/types/routes.d.ts` と `./.next/dev/types/root-params.d.ts` を import
- `AGENTS.md:32-40` に `<!-- BEGIN:nextjs-agent-rules -->` ブロック
- 3 ファイルとも committed・clean

## 実測数値（:548-557）について

plan mode のため未実行。`141 unit` は 139 + `it.each` 2 行 = 141 で算術的に整合。Tier2b の未カバー 2 行の主張（`:62, :67`）も実ファイルの行番号と一致（パースエラーとスキーマエラーの throw 行）。ゲート実測は下記「検証」で実行する。

---

## 是正案

**実施順序: まず「0. 検証結果を shared plan md に記載」を行い、単独でコミットする。** その後に 1〜3 のコード是正へ進む（ユーザー指示）。

### 0. `shared_plan/sharedplan-md-functional-crane.md` に検証結果を記載（★最初に実施）

現行ファイル末尾（`:565` の後）に `# 第三次独立検証（2026-08-06）` セクションを追記する。既存セクションは書き換えない（追記のみ）。内容:

1. **結論** — 第三次実施結果の 4 項目のうち、課題A と `51e57d7` は記載どおり。課題B・課題C は達成しているが記述に誤り／未記載の副作用が計 3 件ある。
2. **課題A の検証（✅ 記載どおり）** — 全 11 ケース（`it` 9 + `it.each` 2 行）を旧バグ順で個別判定した表。検出 3 本 = `:67` / `:84` の 2 行、非検出 8 本とその構造的理由（`customErrorMsg` を渡すのは `createQuestion` のみ、`:77` は `readErrorMessage` が `null` を返すため両実装同値）。偽陽性なしの根拠（3 本の body 文言がすべて fallback `生成に失敗しました` と別文字列）。
3. **課題B の検証（⚠️ 未記載の型安全リグレッション）** — 統合達成点（`client.ts:73-82` / `:27` / `:49-51` / `:54`、`fetch("/api` は `:48` の 1 箇所のみ）を確認したうえで、`request<T>` の戻り値が `Promise<T>` → `Promise<T | null>` に広がり、`client.ts:97` と `:111` に `as AnswerResult` / `as CreatedQuestion` を**本コミットで新設**していた事実を記録。`as` は `any` と違い tsgo にも oxlint にも掛からずどのゲートも検出しないこと、「`src/` の `any` 0 hit」を掲げる本計画の方針と不整合であることを明記。
4. **課題C の検証（⚠️ `:545` の記述が誤り）** — 撤去の機械的完全性（`eslint.config.mjs` 不在 / devDeps 0 件 / `pnpm-lock.yaml` の eslint grep 0 hit / `lint-staged.config.js` / `openspec/config.yaml:13` / `.gitignore` / CI・husky は `lint:fast` のみで実行経路の破壊ゼロ）を先に確認済みとして列挙。そのうえで `:545` を訂正: `react-hooks/set-state-in-effect` は oxlint 1.76 に存在しないルール（native の react-hooks ルールは `exhaustive-deps` と `rules-of-hooks` の 2 つのみ、setState-in-effect の検査は react-compiler crate 内で lint ルール未露出）、`lint:fast` は `--react-hooks-plugin` すら有効化していない、repo に oxlint 設定ファイルは存在しない。実証出力を引用:
   `src/app/answer/use-quiz-session.ts:90:5: warning: Unused eslint-disable directive (no problems were reported).`
   「`lint:fast` 0 件で確認済み」という根拠も無効（`--report-unused-disable-directives` 未指定のため 0 件は「他に何も出ていない」ことしか示さない）ことを追記。
5. **`d5b6cab` の取りこぼし** — `README.md:20`、`IMPLEMENTATION.md:10,32,89,255` が ESLint / `eslint.config.mjs` を現存として記載し続けている。`openspec/specs/study/spec.md` には eslint 参照なし（spec 側は無傷）。`shared_plan/*.md` と `PLAN.md` の `pnpm lint` は歴史的記録として意図的に対象外とする旨も記載。
6. **`51e57d7` の検証（✅ 記載どおり）** — `next-env.d.ts:3-4` の `./.next/dev/types/{routes,root-params}.d.ts`、`AGENTS.md:32-40` のブロック、3 ファイルとも committed・clean。
7. **是正方針** — 下記 1〜3 を実施する旨と、実施後にゲート実測値を追記する旨。

### 1. `request()` の戻り値型を overload で健全化（★最優先）

`src/lib/api/client.ts` — `as` cast 2 箇所を型で消す。

```ts
async function request<T>(
  path: string, init: RequestInit | undefined, label: string,
  schema: z.ZodType<T>, options: RequestOptions & { allowNotFound: true },
): Promise<T | null>;
async function request<T>(
  path: string, init: RequestInit | undefined, label: string,
  schema: z.ZodType<T>, options?: RequestOptions,
): Promise<T>;
async function request<T>(/* 実装シグネチャは現状のまま */): Promise<T | null> { ... }
```

これで `submitAnswer`（`:88-97`）と `createQuestion`（`:101-111`）の `as AnswerResult` / `as CreatedQuestion` を削除でき、`fetchRandomQuestion`（`:73-82`）は `T | null` のまま。実装本体は無変更。

### 2. dead な eslint-disable ディレクティブの処理

`src/app/answer/use-quiz-session.ts:90`。**削除して通常コメント化**（ユーザー確認済み）。

`eslint-disable-next-line` を外し、`void loadNext(true)` を effect から呼ぶ意図（マウント時に最初の問題を取得する / `mountedRef` でアンマウント後の setState を防いでいる）を平文コメントとして残す。`lint:fast` のフラグは変更しない。

### 3. ドキュメントの ESLint 記述を除去

- `README.md:20` → `pnpm, Oxlint, Oxfmt, Prettier`
- `IMPLEMENTATION.md:10, 32, 89, 255` → ESLint / `eslint.config.mjs` の記述を削除
  （`shared_plan/*.md` と `PLAN.md` の `pnpm lint` は歴史的記録なので触らない）

### 4. 是正の実施結果を shared plan md に追記

ステップ 0 で作った `# 第三次独立検証（2026-08-06）` セクションの末尾に、是正コミット一覧（ハッシュ付き）とゲート実測値を追記する。第一次〜第三次の既存記録と同じ書式を踏襲。

## 変更対象の主要ファイル

- `shared_plan/sharedplan-md-functional-crane.md` — 第三次独立検証セクション追記（**最初と最後の 2 回**）
- `src/lib/api/client.ts` — overload 追加、`as` cast 2 箇所削除（`:97`, `:111`）
- `src/app/answer/use-quiz-session.ts:90` — dead ディレクティブを平文コメント化
- `README.md:20`, `IMPLEMENTATION.md:10,32,89,255` — ESLint 記述除去

`package.json` / CI / husky / `openspec/specs/study/spec.md` は変更不要（spec 関連パスの実装変更なし = spec 更新義務なし）。

## 検証（エンドツーエンド）

安い順に fail-fast:

```bash
bash scripts/check-spec-refs.sh
pnpm exec tsgo --noEmit                 # overload の健全性はここで担保
pnpm lint:fast
pnpm lint:fast --report-unused-disable-directives   # 是正2の確認（ワンショット）
pnpm test:coverage                      # 141 passed / 30 files を実測確認
node scripts/check-coverage-tiers.mjs   # 全 6 Tier PASS、Tier2b 94.29% を実測確認
pnpm test:e2e                           # 28 passed
```

加えて課題A の回帰防護を実証する: `client.ts:54` を一時的に旧バグ順（`options?.customErrorMsg ?? (await readErrorMessage(res)) ?? fallback`）へ戻し、`pnpm vitest run tests/api/client.test.ts` で **3 本**が赤くなることを確認してから戻す。

コミットは論理単位で分割（型是正 / ディレクティブ / ドキュメント / 検証記録）、push は 1 回。
