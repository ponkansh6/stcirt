# CI 失敗の再発防止 — pre-push を CI の上位集合にする

## Context

直近 2 コミットはどちらも「push してから CI で初めて気づいた」失敗の後追い修正である。

| commit    | 変更                  | 落ちた CI ステップ               | 内容                                                                           |
| --------- | --------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| `f47d91c` | `pnpm-lock.yaml` のみ | `pnpm security-check`            | `pnpm audit --audit-level=high` が nanoid の advisory で fail。lock を更新     |
| `31729b2` | `package.json` のみ   | `pnpm install --frozen-lockfile` | `f47d91c` で **lock だけをコミットした**結果、specifier が package.json と乖離 |

注目すべきは 2 件目で、**1 件目の修正そのものが 2 件目の障害を作っている**。`pnpm update` 系の操作は `package.json` と `pnpm-lock.yaml` の両方を書き換えるのに、前者だけがコミットから漏れた。この「2 ファイルの同時性」を検証するゲートがどこにも無いため、CI が唯一の検出点になっていた。

### 根本原因

**pre-push フックが CI の上位集合になっていない。** また、従来のフックは「作業ツリー」を検証していたため、**「一部のファイルだけコミットし忘れて作業ツリーに残っている（例: `weighting.ts` 未コミット・`question-repository.ts` コミット済みによる `10dea54` のデプロイ壊れ）」**という事故を検出できなかった。

**不変条件**: pre-push は CI と同じ検証を、**同一のツリー（コミット済みツリー / HEAD tree）**に対して実行する。そのために新設した `scripts/check-head-typecheck.sh` を Stage 0 の先頭に置き、コミット済みツリーの完全性を保証する。

| CI ステップ                      | pre-commit            | pre-push           | 判定                     |
| -------------------------------- | --------------------- | ------------------ | ------------------------ |
| `pnpm install --frozen-lockfile` | ✗                     | ✗                  | **欠落 → 障害 2 の直因** |
| `pnpm type-check:fast`           | ✓ `tsgo --noEmit`     | ✗                  | pre-commit で担保        |
| `pnpm lint:fast`                 | ✓                     | ✗                  | pre-commit で担保        |
| `pnpm format:check`              | △ staged ファイルのみ | ✗                  | **欠落**                 |
| `pnpm test:all`                  | △ `vitest related`    | ✓                  | OK                       |
| `check-spec-refs.sh`             | ✗                     | ✓                  | OK                       |
| Coverage Tier                    | ✗                     | ✓（`src/` 変更時） | OK                       |
| `pnpm security-check`            | ✗                     | ✗                  | **欠落 → 障害 1 の直因** |
| `pnpm build`                     | ✗                     | ✗                  | **欠落**                 |

逆に pre-push にしか無いもの（E2E、本番スキーマ差分、テスト更新漏れ warn）は既に CI の上位。**足りないのは上表の 4 行だけ**である。

`format:check` の △ は見落としやすい: `lint-staged` は `oxfmt --write` を **staged ファイルにしか**かけない。一方 CI の `pnpm format:check` は 140 ファイル全部を見る。`31729b2` で **oxfmt が 0.51.0 → 0.63.0 に上がっている**ため、ステージされていない既存ファイルが新バージョンの整形規則で不適合になる余地が今まさにある（現時点では全件 PASS を実測確認済みだが、次の oxfmt 更新で顕在化しうる）。

### 計測（このリポジトリでの実測値）

| 追加したいチェック                               | 実測時間  |
| ------------------------------------------------ | --------- |
| `pnpm install --frozen-lockfile --lockfile-only` | 0.44s     |
| `pnpm format:check`                              | 2.4s      |
| `pnpm audit --audit-level=high`                  | 1.0s      |
| `pnpm exec secretlint "**/*"`                    | 1.8s      |
| **合計**                                         | **約 6s** |

現行 pre-push は unit test + E2E（2 project）+ coverage で**分単位**。6 秒の追加は誤差であり、しかも**最上段に置けば両障害とも 1 秒未満で止められた**。

### 検証済みの事実（推測ではない）

1. `pnpm install --frozen-lockfile --lockfile-only` は、package.json の specifier を意図的にずらすと `ERR_PNPM_OUTDATED_LOCKFILE` を出し **exit 1**。乖離パッケージ名まで表示する。
2. 同コマンドは in-sync 時 **`pnpm-lock.yaml` も `node_modules/` も書き換えない**（実行後 `git status` がクリーンなことを確認）。
3. husky v9 の runner は `.husky/_/h:17` で **`sh -e "$s"`** を実行している。つまり現行フックは `set -e` を書いていなくても**先頭の失敗で確実に止まる**。ゆえに「速いものを先に置く」ことが直接、失敗検出時間の短縮になる。
4. その帰結として、`.husky/pre-push` の `E2E_EXIT_CODE=$?` / `COVERAGE_EXIT_CODE=$?` / `TIER_EXIT_CODE=$?` の分岐は **到達不能な dead code**（`-e` により直前のコマンド失敗で既に abort している）。
5. `pnpm audit --json` は `{ advisories, metadata.vulnerabilities }` を返す。現状 moderate 1 件で `--audit-level=high` は exit 0。

---

## 設計判断

| 項目                   | 選択                                                                     | 理由                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| フックの配置           | **Stage 0 プリフライト**として pre-push の最上段に集約                   | husky が `sh -e` で回す以上、最初の失敗で止まる。6 秒の静的チェックを分単位のテストより後に置く理由が無い。今回の両障害は 1 秒未満で検出できた                                      |
| lockfile 検証コマンド  | `pnpm install --frozen-lockfile --lockfile-only`                         | CI の `pnpm install --frozen-lockfile` と同じ判定ロジックを使いつつ、`node_modules/` を触らない。0.44s。素の `--frozen-lockfile` を hook で回すと開発者の作業ツリーを書き換えうる   |
| security-check の共有  | `package.json` の `security-check` を `scripts/check-security.sh` に委譲 | CI とフックが**同一エントリポイント**を呼ぶ形にして、片方だけ更新される drift を構造的に防ぐ。CI 側の YAML は `pnpm security-check` のまま無変更                                    |
| audit のオフライン退避 | JSON がパースできなければ warn（**`CI` 未設定時のみ**）                  | `pnpm audit` は脆弱性検出でもレジストリ到達不能でも exit 1。両者を混同すると、オフライン開発中に push が永久に不能になる。`AGENTS.md` が `--no-verify` を禁じているので逃げ道が無い |
| audit は blocking か   | **blocking**                                                             | ローカルで warn にしても CI が blocking なので push は結局失敗する。検出を早めるだけの warn は「見て無視される」だけで、往復が減らない                                              |
| `pnpm build` の扱い    | Stage 4（最後）に追加。関連パス変更時のみ                                | E2E は `pnpm dev` 経由（`playwright.config.ts` の `webServer`）なので、**production build は現状どのフックでも一度も走らない**。RSC 境界違反やルート型生成の失敗はここでしか出ない  |
| lockfile の同時性 warn | pre-commit に **non-blocking** で追加                                    | `package.json` 単独の変更（`scripts` 欄の編集など）は正当なので block できない。「commit 時に warn、push 時に frozen-lockfile で block」の二層にする                                |
| `set -e` の明示        | 各フック先頭に `set -e` を書く                                           | 現状は husky の `sh -e` に暗黙依存している。`bash .husky/pre-push` と手で叩いた時に挙動が変わるのは、フック自体を検証する上で危険                                                   |
| CI 側の変更            | **なし**                                                                 | CI がゲートの正本。フックを CI に寄せるのであって逆ではない。`security-check` の実体差し替えだけは `package.json` 経由で両者に同時に効く                                            |

---

## 実装

### 1. `scripts/check-lockfile-sync.sh`（新規）

`scripts/check-spec-refs.sh` と同じ体裁（`#!/usr/bin/env bash` + `set -euo pipefail` + `[tag]` 付きログ）。

```bash
echo "[lockfile] Checking package.json / pnpm-lock.yaml sync..."
if pnpm install --frozen-lockfile --lockfile-only >/dev/null 2>&1; then
  echo "[lockfile] OK"
  exit 0
fi
```

失敗時は **もう一度出力を捨てずに流して** pnpm の乖離パッケージ一覧を見せたうえで、対処法を明示する:

```
❌ package.json と pnpm-lock.yaml が同期していません（CI の `pnpm install --frozen-lockfile` が落ちます）
   → `pnpm install` を実行し、package.json と pnpm-lock.yaml を **両方** コミットしてください
```

「両方」を強調するのが本質。`31729b2` はまさにこれを守れなかった事故なので、エラーメッセージが再発防止の主役になる。

### 2. `scripts/check-security.sh`（新規）

```bash
set -uo pipefail   # ← audit の exit code を自前で見るので -e は付けない

AUDIT_JSON=$(pnpm audit --audit-level=high --json 2>/dev/null || true)
```

- `AUDIT_JSON` が `metadata.vulnerabilities` を持つ JSON として **パースできるか**を `node -e` で判定する。
  - **パース不能** = レジストリ到達不能 / ネットワーク断。`CI` 環境変数が設定されていれば **exit 1**（CI で握り潰さない）、未設定なら警告のみで **exit 0**。
  - **パース可能** = 判定は成立。`high + critical > 0` なら `pnpm audit --audit-level=high` を再実行して人間向け出力を見せ、**exit 1**。
- 続けて `pnpm exec secretlint "**/*"`。こちらはネットワーク不要なので無条件 blocking。
- **`secretlint` が現状どのフックでも走っていない点は audit より重い**: 秘密情報が commit されても CI で気づく頃には既に push 済みでヒストリに残っている。本変更で pre-push 段階に前倒しされる。

`package.json`:

```json
"security-check": "bash scripts/check-security.sh"
```

CI の `- name: Security Check / run: pnpm security-check` は**無変更**のまま新実装を拾う。

### 3. `.husky/pre-push` — Stage 構成に再編

```sh
#!/bin/sh
set -e            # husky の `sh -e` に依存しない（手動実行でも同じ挙動に）
```

`MERGE_BASE` / `PUSH_FILES` の算出は現行のまま先頭に残す。

**Stage 0 — Preflight（約 6s、常時実行）** ← 新設。最上段。

1. `bash scripts/check-lockfile-sync.sh` ← 障害 2 を止める
2. `pnpm format:check` ← lint-staged が見ない未ステージファイルを拾う
3. `bash scripts/check-security.sh` ← 障害 1 を止める
4. `bash scripts/check-spec-refs.sh` ← 現行の先頭。ここに合流

**Stage 1 — テスト更新漏れ warn**（現行のまま、non-blocking）

**Stage 2 — `pnpm test:all`**（現行のまま）

**Stage 3 — E2E**（現行のまま。ただし `E2E_EXIT_CODE=$?` の dead code を削除し `pnpm test:e2e` の直呼びにする）

**Stage 4 — Coverage Tier**（現行のまま。`$?` 分岐を削除）

**Stage 5 — `pnpm build`** ← 新設

```sh
if echo "$PUSH_FILES" | grep -qE "^(src/|next\.config\.ts|vercel\.ts|package\.json|tsconfig\.json)"; then
  NEXT_BUILD=1 pnpm build
fi
```

- `NEXT_BUILD=1` は CI の env と揃えるため。`src/lib/db/index.ts:13` で `TURSO_DATABASE_URL` 不在時に `:memory:` へフォールバックする分岐に効く。`.env.local` に URL がある環境では実質 no-op だが、**無い環境でも CI と同じ経路で通る**ようにするために必要。
- パスゲートを付けるのは、ドキュメントや `shared_plan/` だけの push で 30〜60 秒を払わないため。

**Stage 6 — 本番スキーマ差分**（現行のまま、最後）

### 4. `.husky/pre-commit` — lockfile 同時性 warn（non-blocking）

先頭に `set -e` を明示。既存 4 コマンドの後、`scripts/check-spec-update.sh` と同じ「警告のみ・必ず `exit 0`」の体裁で:

```sh
STAGED=$(git diff --cached --name-only)
```

`package.json` と `pnpm-lock.yaml` の**片方だけ**が staged なら枠付き警告を出す。`check-spec-update.sh` が既に確立している文体をそのまま踏襲する（別 UI を作らない）。

**block しない理由**: `package.json` の `scripts` / `engines` だけを直す正当なコミットが存在する。block すると開発者が回避策を探し始め、`AGENTS.md` が禁じている `--no-verify` に手が伸びる。実効的なゲートは Stage 0-1 の frozen-lockfile 側に置く。

### 5. `AGENTS.md` — 検証ゲート一覧の更新

「自動チェック」節に、pre-push が **lockfile 同期 / format / security(audit + secretlint) / build** も見るようになったことを追記する。Orchestrator が回す検証ゲートの列挙（`lint, type-check, test, coverage, spec-refs, smoke-test`）にも `lockfile-sync`, `format`, `security`, `build` を足す。

---

## テスト

シェルスクリプトなので Vitest の対象にはしない（既存 `scripts/check-*.sh` にもテストは無く、`check-coverage-tiers.mjs` を含め coverage Tier の対象外）。代わりに**手で壊して確かめる**手順を確定させる。

### `scripts/check-lockfile-sync.sh`

1. クリーンな状態で実行 → `[lockfile] OK`、exit 0、**実行後に `git status` がクリーン**（lock を書き換えていないことの確認。これを毎回見る）。
2. `package.json` の任意の specifier を 1 つ書き換えて実行 → exit 1、乖離パッケージ名と「両方コミット」の指示が出る。**元に戻す**。
3. `pnpm-lock.yaml` 側だけを古い状態に戻して実行 → exit 1（逆向きの乖離も検出できること）。

### `scripts/check-security.sh`

4. 通常実行 → exit 0（現状 moderate 1 件は `--audit-level=high` を通過する）。
5. ネットワークを落として実行 → **exit 0 + 警告**（ローカル）。
6. `CI=1` を付けて同じくネットワーク断で実行 → **exit 1**（CI では握り潰さない）。
7. ダミーの API キー文字列を含むファイルを一時的に置いて実行 → secretlint が exit 1。**必ず削除する**。

### フック全体

8. `bash .husky/pre-push` を直接実行 → `set -e` により Stage 0 で止まる状況を作って abort を確認（husky 経由でなくても同じ挙動になったこと）。
9. `package.json` だけをずらして実際に `git push` を試みる → **Stage 0 で 1 秒以内に止まる**。これが `31729b2` の再現テストであり、本計画の合否そのもの。
10. `shared_plan/*.md` だけを変更した push → Stage 5 の `pnpm build` が**スキップされる**。
11. `src/` を変更した push → Stage 5 の `pnpm build` が走って通る。
12. `.husky/pre-commit` で `pnpm-lock.yaml` だけを stage → 警告が出るが **commit は成功する**。

### 全体の再検証

```bash
pnpm format:check && pnpm lint:fast
pnpm type-check:fast && pnpm type-check
pnpm test
pnpm exec vitest run --coverage && node scripts/check-coverage-tiers.mjs
bash scripts/check-spec-refs.sh
pnpm security-check      # ← 新実装が CI と同じ入口で動くことの確認
pnpm test:e2e
NEXT_BUILD=1 pnpm build
```

---

## 仕様書更新 — `openspec/specs/study/spec.md`

本変更は `src/` を触らないため R 番号の追加は不要。既存節への追記に留める。

- **Testing**: 「Coverage gates」の後に **`## CI / Git Hooks`** 相当の記述を足すか、既存 Testing 節末尾に pre-commit / pre-push / CI の対応表（本計画の Context の表）を載せる。**CI が正本で、pre-push はその上位集合である**という不変条件を明文化するのが主目的。この 1 行があると、次に CI ステップを足す人がフック側も足すべきだと気づける。
- **Non-Functional**: 「依存更新時は `package.json` と `pnpm-lock.yaml` を必ず同一コミットに含める」を追記。
- `scripts/check-lockfile-sync.sh` / `scripts/check-security.sh` への参照を書く場合は、**実ファイル作成後（同一コミット内）に書く**（`check-spec-refs.sh` は `src/` と `tests/` のパスのみ検証するので `scripts/` は対象外だが、記述の鮮度は保つ）。

### codemap 更新

ルート `codemap.md` に `scripts/` の一覧があれば 2 本を追記。

---

## 実装順序

1. `scripts/check-lockfile-sync.sh` を作り、**手順 1〜3 を先に通す**（一番効くゲートを最初に確定させる）
2. `scripts/check-security.sh` + `package.json` の `security-check` 差し替え、手順 4〜7
3. `.husky/pre-push` を Stage 構成に再編（`set -e` 明示、dead code 削除、Stage 0 新設）
4. `.husky/pre-push` に Stage 5 `pnpm build` を追加、手順 10〜11
5. `.husky/pre-commit` に `set -e` と lockfile 同時性 warn、手順 12
6. 手順 8〜9（再現テスト）
7. `AGENTS.md`
8. `spec.md` + codemap

---

## 注意点（ハマりどころ）

1. **`pnpm install --frozen-lockfile` を素で hook から呼ばない**。開発者の `node_modules/` を書き換える。必ず `--lockfile-only` を付ける。
2. **audit の「脆弱性あり」と「レジストリに繋がらない」を混同しない**。両方 exit 1 なので、JSON がパースできたかで分ける。混同すると機内で push できなくなり、`AGENTS.md` が禁じる `--no-verify` に追い込む。
3. **`CI` が設定されている時はオフライン退避をしない**。CI で握り潰すと `f47d91c` の再発を検出できない。
4. **audit は自分の変更と無関係に、時間経過だけで落ちうる唯一のゲート**。これは仕様であって不具合ではない。本フックは検出を CI から push 直前へ前倒しするだけで、advisory 公開そのものは防げない（根本対処は定期的な依存更新の自動化＝本計画の非目標）。
5. **Stage 0 を最上段から動かさない**。husky が `sh -e` で回すので、順序がそのまま検出時間になる。テストの後ろに置いた瞬間、6 秒のチェックのために数分待つことになる。
6. **`$?` を使った既存の分岐は削除する**。`set -e` 下では到達不能で、読む人に「ここは非 blocking かもしれない」と誤解させる。
7. **pre-commit の lockfile チェックを blocking にしない**。`package.json` 単独の正当な変更を塞ぐ。
8. `pnpm build` に `NEXT_BUILD=1` を付け忘れると、`TURSO_DATABASE_URL` の無い環境で `src/lib/db/index.ts:17` の throw に当たる。
9. **CI の YAML は変更しない**。`security-check` の実体は `package.json` 経由で差し替わるので、CI 側は触らずに新実装を拾う。ここで YAML も編集すると、フックと CI が別々に育つ元の問題を再生産する。
10. `secretlint` を pre-push に入れると、**既存のヒストリに秘密情報があった場合その場で push が止まる**。導入時に一度クリーンであること（現状 exit 0）を確認済みだが、初回導入時は必ず単体で流してから hook に組み込む。
11. スクリプトは `scripts/check-spec-refs.sh` に倣い `#!/usr/bin/env bash` + `set -euo pipefail`。ただし `check-security.sh` は exit code を自前で分岐するため **`-e` を外す**（付けると audit の非ゼロで即死し、オフライン判定に到達しない）。

---

## 非目標（今回やらないこと）

- **CI ワークフロー（`.github/workflows/main.yml`）の変更**。CI がゲートの正本であり、寄せるのはフック側。
- **Renovate / Dependabot の導入**。`f47d91c` の根本対処（advisory を待たずに依存を上げ続ける）としては正しいが、フック計画とは別軸。導入すれば audit failure の頻度自体が下がる、という関係にある。
- **pre-commit への重いゲート追加**。コミット単位の摩擦を上げると分割コミットが避けられ、レビュー粒度が悪化する。重い検証は push 境界に置く。
- **`pnpm type-check`（tsc フル）の pre-push 追加**。CI も `type-check:fast`（tsgo）しか回していないので、フックだけ厳しくしても CI 失敗の再発防止にはならない。
- **hook の実行時間そのものの最適化**（E2E の並列化等）。本計画は「順序」で体感を改善するに留める。
