# pre-commit / pre-push フックの他プロジェクトからの採用検討

## Context

隣接プロジェクト `nextjstest`・`news-watch`（いずれも `/home/shunki/working/` 配下）の `.husky/pre-commit` `.husky/pre-push` を、本プロジェクト（`study`）の同フックと比較調査した。

**study の現状:**

- `pre-commit`: `lint:fast` → `oxfmt --write .` → `tsgo --noEmit` → `lint-staged`
- `pre-push`: テストファイル追随警告（`src/` 変更時に `tests/` 未変更なら警告）→ `pnpm test:all`（unit のみ）→ 本番スキーマドリフト検知（`.env.local` があれば実行）

**3プロジェクト比較表:**

| チェック内容                                                      | study | nextjstest    | news-watch                            |
| ----------------------------------------------------------------- | ----- | ------------- | ------------------------------------- |
| lint:fast / oxfmt / tsgo / lint-staged (pre-commit)               | ✅    | ✅            | ✅(oxfmt --write は lint-staged 経由) |
| テストファイル追随警告 (pre-push)                                 | ✅    | ✅            | ✅                                    |
| 本番スキーマドリフト検知 (pre-push, env-gated)                    | ✅    | —             | ✅                                    |
| **spec.md 更新忘れ警告 (pre-commit, non-blocking)**               | ❌    | —             | ✅ `check-spec-update.sh`             |
| **spec.md 更新忘れ警告 (pre-push, non-blocking)**                 | ❌    | ✅            | —                                     |
| **spec.md 内のファイル参照の有効性チェック (pre-push, blocking)** | ❌    | —             | ✅ `check-spec-refs.sh`               |
| **E2E テストの pre-push 実行**                                    | ❌    | ✅ `test:e2e` | —                                     |
| ローカルDBでのスキーマ整合性テスト (pre-push)                     | ❌    | —             | ✅ `schema-consistency.test.ts`       |
| **カバレッジ Tier 検証 (pre-push, non-blocking から段階導入)**    | ❌    | —             | ✅ `check-coverage-tiers.mjs`         |

study は AGENTS.md で「仕様書パス: `openspec/specs/study/spec.md`」「実装変更と並行して仕様書を更新」と**明文化しているにもかかわらず、これを自動チェックする仕組みが一切ない**。これは他の2プロジェクトが既に持っている仕組みで、study にとって最も価値が高いギャップだと判断した。

また study の `package.json` には `"test:e2e": "playwright test"` が既に存在し、直前のタスクで22件のe2eテストが揃っている（`shared_plan/SELECTION_FEEDBACK_PLAN.md` 検証済み）にもかかわらず、**pre-push では実行されていない**。nextjstest はこれを実行することで実際にバグ（`page.tsx` の `quarterlyKeys` 欠落）を検知した実績がpre-push内のコメントに記録されており、有効性が実証されている。

---

## 採用する項目（優先度順）

### 1. spec.md 参照の有効性チェック（pre-push, blocking）— 高優先度・低コスト

news-watch の `scripts/check-spec-refs.sh` を移植する。`spec.md` 内の `` `src/...` `` `` `tests/...` `` バッククォート参照を抽出し、実在しないファイルを指していれば **push をブロック**する。ロジックはプロジェクト非依存（正規表現でパスを抜き出して `[ -f ]`/`[ -d ]` チェックするだけ）なので、`SPEC_FILE` の値を `openspec/specs/study/spec.md` に変えるだけで移植できる。

### 2. spec.md 更新忘れ警告（pre-commit, non-blocking）— 高優先度・低コスト

news-watch の `scripts/check-spec-update.sh` を移植する。staged ファイルが spec 関連パスに一致し、かつ `spec.md` 自体が staged されていない場合に警告（**commit はブロックしない**）。news-watch は静的パターンリスト + spec.md からの動的抽出の2層構成だが、study は AGENTS.md に「コンポーネント追加/削除・データモデル変更・API変更・アーキテクチャ変更」という基準が既にあるため、静的パターンは `src/app/`, `src/lib/db/schema.ts`, `src/lib/db/repository/`, `src/app/api/` 等、主要な構成要素に絞って移植する。

### 3. pre-push での E2E テスト実行 — 中優先度・中コスト

nextjstest の pre-push に倣い、`pnpm test:all` の後に `pnpm test:e2e` を追加する。exit code を明示的にチェックして失敗時は push を止める。Playwright は実ビルド・実サーバーを起動するため pre-push の所要時間が伸びる点はトレードオフ（nextjstest はこれを許容し、実際にバグを検知した実績がある）。

### 4. カバレッジ Tier 検証（pre-push, 段階導入）— 中〜低優先度・中コスト

**ユーザーフィードバックにより採用に変更**（当初は移植コストを理由に見送っていたが、「考え方」自体は取り入れる方針に修正）。

news-watch の `scripts/check-coverage-tiers.mjs`（重要度別にモジュールをTier分けし、Tierごとにカバレッジ目標を設定する仕組み）を移植する。ただし以下の理由から、**そのまま blocking で導入するのではなく、まず non-blocking（レポートのみ）で導入し、実測値が出揃ってから段階的に blocking 化する**:

- study には `@vitest/coverage-v8` が未インストール（`pnpm exec vitest run --coverage` を実行して確認済み。news-watch は `4.1.9` を devDependency として持つ）
- 既存テストの多くが `vi.mock` でモジュールを丸ごとモック化しており（例: `tests/api/questions.test.ts` は `generateQuestion` と `createKnowledgeWithQuestion` をモック）、`src/lib/db/repository/*` や `src/lib/llm/quiz.ts`/`client.ts` の**実カバレッジは現状ほぼ0%**と推測される
- news-watch の固定ターゲット（Tier1: 95%, Tier2: 85% など）をそのまま blocking で入れると、初回実行から全ての push が失敗する

**study 向け Tier 分類案**（news-watch の「重要度が高いほど厳しい目標」という考え方を踏襲し、study のモジュール構成に合わせて再設計）:

| Tier                             | 対象                                                                                               | 目安（初期は参考値、実測後に確定） |
| -------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1. Core domain logic             | `src/lib/shuffle.ts`, `src/lib/choice-label.ts`, `src/lib/llm/schemas.ts`, `src/lib/llm/parser.ts` | 高（純粋関数中心、テストしやすい） |
| 2. API / LLMオーケストレーション | `src/app/api/**/route.ts`, `src/lib/llm/quiz.ts`, `src/lib/llm/client.ts`                          | 中                                 |
| 3. データアクセス                | `src/lib/db/repository/*.ts`                                                                       | 中（現状ほぼ未直接テスト）         |
| 4. UI状態管理                    | `src/app/answer/use-quiz-session.ts`                                                               | 高（既存テスト充実）               |
| 5. UIコンポーネント              | `src/components/*.tsx`                                                                             | 中〜低                             |

**導入フェーズ:**

- **Phase 1（今回のスコープ）**: `@vitest/coverage-v8` を追加、`test:coverage` script を追加、`check-coverage-tiers.mjs` を study 向け Tier で作成。pre-push では `src/` 変更時のみ実行し、**結果を表示するだけで exit code に関わらず push は継続**（`|| true` 相当）。これで実際のTierごとの数値を継続的に可視化する
- **Phase 2（将来タスク）**: Phase 1 で数値が安定して見えてきた段階で、Tier ごとに現実的なターゲットを設定し、目標を下回った場合に push をブロックする（news-watch と同じ運用）に切り替える

---

## 見送る項目（理由付き）

### ローカルDBでのスキーマ整合性テスト（news-watch: `tests/db/schema-consistency.test.ts`）

- 目的（schema.ts とDBの実体のズレを検知）自体は study にも有効だが、news-watch の実装は **drizzle-kit generate で生成された `migrations/*.sql` ファイル**を前提にしている
- study の `drizzle.config.ts` は `out: "./src/lib/db/migrations"` を指しているが、**このディレクトリは現在存在せず**、`db:push`（マイグレーションファイルを介さない直接反映）で運用されている
- そのため「migrations に CREATE TABLE があるか」のサブテストはそのまま移植できず、テスト用DBの用意（インメモリDBへのスキーマ適用の仕組み）も別途必要
- study には既に `scripts/check-prod-schema.sh`（env-gated, pre-push）が本番Turso DBに対する同種のドリフト検知を行っており、リスクは一定カバーされている
- **今回は見送り、将来 study が migrations ファイル運用に切り替えるタイミングで再検討する**

---

## 変更内容

### 1. `scripts/check-spec-refs.sh`（新規、news-watch から移植・パス調整）

`SPEC_FILE="openspec/specs/news-watch/spec.md"` → `SPEC_FILE="openspec/specs/study/spec.md"` に変更する以外はロジックそのまま。

### 2. `scripts/check-spec-update.sh`（新規、news-watch から移植・パターン調整）

`SPEC_SENSITIVE_PATTERNS` を study の構成に合わせて置き換える:

```bash
SPEC_SENSITIVE_PATTERNS=(
  "src/lib/db/schema.ts"
  "src/lib/db/repository/"
  "src/app/api/"
  "src/app/answer/"
  "src/app/create/"
  "src/app/page.tsx"
  "src/app/layout.tsx"
  "src/components/"
)
```

`SPEC_FILE="openspec/specs/study/spec.md"` に変更。

### 3. `.husky/pre-commit`

末尾に追加:

```sh
bash scripts/check-spec-update.sh
```

### 4. `.husky/pre-push`

- 冒頭に spec 参照チェックを追加（既存の `MERGE_BASE`/`PUSH_FILES` 算出はそのまま活用）:

```sh
if ! bash scripts/check-spec-refs.sh; then
  exit 1
fi
```

- `pnpm test:all` の後、本番スキーマチェックの前に E2E テストを追加:

```sh
echo "Running E2E tests..."
pnpm test:e2e
E2E_EXIT_CODE=$?
if [ $E2E_EXIT_CODE -ne 0 ]; then
  echo "E2E tests failed with code $E2E_EXIT_CODE"
  exit $E2E_EXIT_CODE
fi
```

- E2E テストの後（またはその前）、`src/` 変更時のみ Phase 1 のカバレッジレポートを追加（non-blocking）:

```sh
if echo "$PUSH_FILES" | grep -qE "^src/"; then
  echo ""
  echo "📊 Running coverage tier report (non-blocking)..."
  pnpm exec vitest run --coverage 2>/dev/null
  node scripts/check-coverage-tiers.mjs || true
  echo ""
fi
```

### 5. `package.json`

- `devDependencies` に `@vitest/coverage-v8`（study の vitest バージョン `^4.1.9` に合わせて追加）
- `scripts` に `"test:coverage": "vitest run --coverage"` を追加

### 6. `scripts/check-coverage-tiers.mjs`（新規、news-watch から移植・Tier定義を study 向けに全面差し替え）

news-watch 版のスクリプト構造（`coverage/coverage-summary.json` を読み、Tierごとの `patterns`（正規表現配列）と `target`・`metric` を突き合わせて判定）はそのまま流用し、`TIERS` 配列の中身だけを上表の study 向け Tier 分類に差し替える。Phase 1 では判定結果を表示するのみとし、exit code は 0 固定（または呼び出し側の pre-push で `|| true` して無視）にしておく。Phase 2 で blocking 化する際に、この exit code 制御を有効化する。

---

## テスト

フック自体はシェルスクリプトのため、以下の手動確認で検証する（フックのユニットテストは行わない）:

1. `spec.md` に存在しないファイル参照を一時的に追記 → `git push`（dry-run的に `bash scripts/check-spec-refs.sh` を直接実行）→ exit 1 になることを確認、その後元に戻す
2. `src/app/api/` 配下のファイルを変更して spec.md を変更せずに `git commit` → 警告が出るが commit は成功することを確認
3. `pnpm test:e2e` をわざと失敗させる（例: 存在しないテストへの一時的な参照）→ pre-push が exit 非0 で止まることを確認
4. `src/` 配下のファイルを変更して commit → push 時にカバレッジ Tier レポートが表示されるが、目標未達でも push がブロックされないことを確認（Phase 1 の non-blocking 挙動）

---

## ドキュメント同期

- `AGENTS.md` の「仕様書管理」セクションに、自動チェック（pre-commit warn / pre-push blocking）が導入された旨を追記する（任意、運用ルールの明文化）

---

## 実装順序

1. `scripts/check-spec-refs.sh` を移植・調整
2. `scripts/check-spec-update.sh` を移植・調整
3. `.husky/pre-commit` に warn チェックを追加
4. `.husky/pre-push` に spec refs チェック（先頭）と E2E テスト実行を追加
5. `@vitest/coverage-v8` の追加・`test:coverage` script 追加・`scripts/check-coverage-tiers.mjs`（study向けTier, non-blocking）を追加し、`.husky/pre-push` に組み込み
6. 手動確認（上記テスト項目）
7. 必要なら AGENTS.md に追記

将来（Phase 2, 別タスク）: カバレッジ実測値が安定したら Tier ターゲットを確定し、`check-coverage-tiers.mjs` の exit code を pre-push でブロッキングに切り替える。

AGENTS.md の制約に従い、`--no-verify` / `HUSKY=0` は使用しない。

---

## 検証

```bash
pnpm type-check
pnpm lint
pnpm test
bash scripts/check-spec-refs.sh   # exit 0 であることを確認（現状のspec.mdに壊れた参照がないか）
```

---

## 進捗

- [100%] `check-spec-refs.sh` / `check-spec-update.sh` / `check-coverage-tiers.mjs` を news-watch から移植し、`.husky/pre-commit`（spec更新警告）と `.husky/pre-push`（spec参照チェック blocking / E2E blocking / カバレッジTierレポート non-blocking）に組み込み。`@vitest/coverage-v8` と `test:coverage` スクリプトを追加し、`vitest.config.ts` に v8 coverage 設定を追加。AGENTS.md に自動チェックを追記。Phase 2（カバレッジ blocking 化）は将来タスク。
