# 出題優先度ロジックの改訂 — 忘却曲線（経過時間）と絶対回数の導入

## Context

ユーザー要望:

> 直近で正解した問題や正解数が多い問題を優先度低く、直近で解いていない問題や誤答数が多い問題を優先度高くするような出題ロジックに

現行の重み付けは `src/lib/db/repository/weighting.ts:8-13` の 6 行がすべてで、**正誤比率と「直近1回の正誤」しか見ていない**。

```ts
export function computeWeight(stats: WeightStats | null | undefined): number {
  if (!stats || stats.answered <= 0) return 5;
  const incorrectRatio = stats.incorrect / stats.answered;
  const weight = 1 + 4 * incorrectRatio;
  return stats.latestIncorrect ? weight + 2 : weight;
}
```

要望 4 項目に対する現状の充足度:

| 要望                               | 現状 | 理由                                                                                      |
| ---------------------------------- | ---- | ----------------------------------------------------------------------------------------- |
| 直近で正解した問題を優先度低く     | ❌   | **経過時間の概念が一切ない**。1 分前に正解した問題と 3 ヶ月前に正解した問題の重みが同一   |
| 正解数が多い問題を優先度低く       | ❌   | 比率のみ。`1問中1正解` も `50問中50正解` も等しく weight = 1                              |
| 直近で解いていない問題を優先度高く | ❌   | 同上。経過時間による押し上げが存在しない                                                  |
| 誤答数が多い問題を優先度高く       | △    | 比率としては効くが**絶対回数は無視**。`2問中1誤答` も `100問中50誤答` も等しく weight = 3 |

つまり 4 項目中 3 項目が未実装で、残り 1 項目も比率でしか効いていない。本計画は `computeWeight` に **経過時間（recency）** と **絶対回数（正解数の減衰・誤答数の加算）** の 2 軸を追加する。

`pickByWeight`（重み付き抽選そのもの）と、`use-quiz-session.ts:68` の直近 10 件除外は**変更しない**。

---

## 設計判断（根拠つき）

| 項目                 | 選択                                              | 理由                                                                                                                                                                              |
| -------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 合成方法             | **乗算**（加算ではない）                          | 4 軸を加算すると「正解数が多い」の減衰が他項の底上げで打ち消される。乗算なら熟知した問題を確実に 1 未満へ落とせる                                                                 |
| 経過時間の関数       | 線形ランプ（`RECENCY_FULL_DAYS` で頭打ち）        | 指数減衰は係数の意味が直感的でなく、テストで期待値を書きづらい。単調増加と頭打ちさえ満たせば十分                                                                                  |
| 直近誤答時の recency | `max(1, recency)` で下限を 1 に切り上げ           | 「直近で正解 → 下げる」が要望であって「直近で誤答 → 下げる」ではない。素の recency を掛けると**さっき間違えた問題が最も出にくくなる**という逆転が起きる                           |
| 絶対回数の上限       | `MISS_CAP` / `MASTERY_CAP` でクリップ             | 上限がないと 1 問だけ突出して他が実質抽選されなくなる                                                                                                                             |
| 重みの下限           | `WEIGHT_MIN = 0.1`（**0 にしない**）              | `pickByWeight` は `totalWeight <= 0` で `null` を返す（`weighting.ts:26`）。全問が「たった今正解済み」の状態で総和 0 になると `question-repository.ts:136` の fallback に落ちる   |
| `now` の受け渡し     | `computeWeight(stats, now)` の**第 2 引数で必須** | `new Date()` を関数内で呼ぶと純粋関数でなくなりテストが時刻依存になる。かつ 1 回の抽選で全問が**同一の基準時刻**を共有しないと問題間で微小なドリフトが出る                        |
| 定数の置き場         | `weighting.ts` から named export                  | `src/lib/constants.ts` は LLM 設定などのクロスモジュール設定用。重み係数はこのモジュールのドメインルールそのもので、spec.md も weighting.ts を「pure logic module」と定義している |
| DB スキーマ          | **変更なし**（マイグレーション不要）              | 必要な情報は `answer_logs.answered_at` に既にある。`max()` は既存の `answer_logs_question_answered_at_idx` で賄える                                                               |

---

## 実装

### 1. `src/lib/db/repository/weighting.ts` — 重み計算の全面改訂

#### 1-1. 定数（すべて export、テストから参照する）

```ts
/** 未解答の問題に与える固定重み */
export const UNSEEN_WEIGHT = 12;
/** 誤答数の絶対回数ボーナス: 1 + MISS_COEF * min(incorrect, MISS_CAP) → 1.0〜3.0 */
export const MISS_COEF = 0.5;
export const MISS_CAP = 4;
/** 正解数の減衰: 1 / (1 + MASTERY_COEF * min(correct, MASTERY_CAP)) → 1.0〜0.364 */
export const MASTERY_COEF = 0.35;
export const MASTERY_CAP = 5;
/** 経過時間ランプ: RECENCY_MIN → RECENCY_MAX を RECENCY_FULL_DAYS 日でリニアに */
export const RECENCY_MIN = 0.2;
export const RECENCY_MAX = 3;
export const RECENCY_FULL_DAYS = 7;
/** 直近が誤答だったときの倍率 */
export const LATEST_MISS_MULT = 2;
/** クランプ */
export const WEIGHT_MIN = 0.1;
export const WEIGHT_MAX = 30;
```

#### 1-2. `WeightStats` に `lastAnsweredAt` を追加

```ts
export interface WeightStats {
  answered: number;
  incorrect: number;
  latestIncorrect: boolean;
  /** 最終解答時刻。answered > 0 なら通常は非 null */
  lastAnsweredAt: Date | null;
}
```

`correct` は `answered - incorrect` で導出するのでフィールドを増やさない。

#### 1-3. `computeWeight(stats, now)`

```ts
export function computeWeight(stats: WeightStats | null | undefined, now: Date): number {
  if (!stats || stats.answered <= 0) return UNSEEN_WEIGHT;

  const incorrect = stats.incorrect;
  const correct = Math.max(0, stats.answered - incorrect);

  // 比率軸（従来ロジックを踏襲）: 1.0〜5.0
  const accuracyTerm = 1 + 4 * (incorrect / stats.answered);
  // 絶対誤答回数: 1.0〜3.0
  const missBonus = 1 + MISS_COEF * Math.min(incorrect, MISS_CAP);
  // 絶対正解回数による減衰: 1.0〜0.364
  const masteryDecay = 1 / (1 + MASTERY_COEF * Math.min(correct, MASTERY_CAP));

  // 経過日数。lastAnsweredAt が null（欠損）なら「十分に古い」扱い。
  // 未来日時（クロックスキュー）は 0 に切り上げ。
  const elapsedDays =
    stats.lastAnsweredAt === null
      ? RECENCY_FULL_DAYS
      : Math.max(0, (now.getTime() - stats.lastAnsweredAt.getTime()) / DAY_MS);
  let recency =
    RECENCY_MIN + (RECENCY_MAX - RECENCY_MIN) * Math.min(1, elapsedDays / RECENCY_FULL_DAYS);

  // 直近が誤答なら recency で押し下げない（下限 1.0）
  if (stats.latestIncorrect) recency = Math.max(1, recency);

  const raw =
    accuracyTerm *
    missBonus *
    masteryDecay *
    recency *
    (stats.latestIncorrect ? LATEST_MISS_MULT : 1);

  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, raw));
}
```

`DAY_MS = 24 * 60 * 60 * 1000` はモジュール内ローカル定数（`src/lib/date.ts:2` にも同名の非 export 定数があるが、`date.ts` は JST 日付境界専用モジュールなので import せず重複させる。export 化して共有するのは変更範囲を広げる割に得がない）。

#### 1-4. 想定される重みの分布（検算済み）

| ケース                        | accuracy | miss | mastery | recency | ×miss | **weight**      |
| ----------------------------- | -------- | ---- | ------- | ------- | ----- | --------------- |
| 10問10正解・直近正解・**0日** | 1.0      | 1.0  | 0.364   | 0.2     | 1     | **0.10** ← 下限 |
| 2問2正解・直近正解・0日       | 1.0      | 1.0  | 0.588   | 0.2     | 1     | **0.12**        |
| 10問10正解・直近正解・**7日** | 1.0      | 1.0  | 0.364   | 3.0     | 1     | **1.09**        |
| 2問2正解・直近正解・7日       | 1.0      | 1.0  | 0.588   | 3.0     | 1     | **1.76**        |
| 4問2誤答・直近正解・1日       | 3.0      | 2.0  | 0.588   | 0.6     | 1     | **2.12**        |
| 4問2誤答・直近誤答・0日       | 3.0      | 2.0  | 0.588   | 1.0     | 2     | **7.06**        |
| **未解答**                    | —        | —    | —       | —       | —     | **12.0**        |
| 10問8誤答・直近誤答・0日      | 4.2      | 3.0  | 0.588   | 1.0     | 2     | **14.82**       |
| 1問1誤答・直近誤答・0日       | 5.0      | 1.5  | 1.0     | 1.0     | 2     | **15.0**        |
| 10問10誤答・直近誤答・7日     | 5.0      | 3.0  | 1.0     | 3.0     | 2     | **30.0** ← 上限 |

要望との対応:

- **直近で正解した問題 → 低**: 同一の正解実績でも 0 日なら 0.10、7 日なら 1.09（**約 11 倍**の差）
- **正解数が多い問題 → 低**: 同条件で 2 正解 0.12 → 10 正解 0.10（`MASTERY_CAP` まで単調減少）
- **直近で解いていない問題 → 高**: recency が 0.2 → 3.0（15 倍）。未解答は固定 12.0
- **誤答数が多い問題 → 高**: 比率 `accuracyTerm` に加え、絶対回数 `missBonus` が最大 3 倍

既知のトレードオフ: `1問1誤答`(15.0) が `10問8誤答`(14.82) を僅かに上回る。前者は比率 1.0・masteryDecay 1.0、後者は 2 回の正解実績で減衰が効くため。実害のない範囲の逆転で、`MISS_COEF` を上げれば解消できる（本計画では現状値のまま据え置く）。

### 2. `src/lib/db/repository/question-repository.ts` — 最終解答時刻の取得

`pickWeightedRandomQuestion`（`:71-151`）を 4 点変更する。

**(a) 基準時刻を 1 回だけ確定**（関数先頭）

```ts
const now = new Date();
```

**(b) 集計クエリに `max(answered_at)` を追加**（`:86-97` の select）

```ts
lastAnsweredAt: sql<number>`max(${answerLogs.answeredAt})`,
```

⚠️ **`answered_at` は `mode: "timestamp"`（`schema.ts:37`）= UNIX 秒**。raw `sql` はドリズルの timestamp マッピングを経由しないため、**`Date` 化には ×1000 が必須**。ここを落とすと全問が 1970 年扱い → recency が全問 `RECENCY_MAX` に張り付き、経過時間ロジックが無言で死ぬ（テスト 4-2 が回帰検知を担う）。

**(c) 既存の `latestIsCorrect` 相関サブクエリにタイブレークを追加**（`:90-94`）

```sql
ORDER BY l2.answered_at DESC, l2.id DESC LIMIT 1
```

`answered_at` は秒精度なので**同一秒に複数回解答すると「最新」が非決定**になる既存の潜在バグ。`id DESC` を足して確定させる。インデックスは先行列 `(question_id, answered_at desc)` が引き続き効くため性能影響なし。

**(d) `statsMap` と `computeWeight` 呼び出し**（`:101-133`）

```ts
const ts = Number(row.lastAnsweredAt);
statsMap.set(row.questionId, {
  totalAnswers: Number(row.totalAnswers),
  incorrectAnswers: Number(row.incorrectAnswers),
  latestCorrect: Number(row.latestIsCorrect) === 1,
  lastAnsweredAt: Number.isFinite(ts) ? new Date(ts * 1000) : null,
});
```

```ts
const weight = computeWeight(
  stat
    ? {
        answered: stat.totalAnswers,
        incorrect: stat.incorrectAnswers,
        latestIncorrect: !stat.latestCorrect,
        lastAnsweredAt: stat.lastAnsweredAt,
      }
    : null,
  now,
);
```

**(e) `:64-70` の Scale note コメントを更新** — 計算軸が増えた旨（統計に `max(answered_at)` が加わったこと）を反映。

変更なし: 除外リスト処理（`:113-118`）、fallback（`:135-144`）、戻り値の形。

### 3. 変更しないもの（明示）

- `pickByWeight` — 抽選アルゴリズム自体は無変更
- `src/app/api/questions/random/route.ts` — API 契約・レスポンス形状ともに不変
- `src/app/answer/use-quiz-session.ts:68` の直近 10 件除外 — recency は秒精度なので「同一セッション内で数秒後に同じ問題」を防ぐ役割はなお必要。両者は補完関係
- `src/lib/db/schema.ts` / `migrations/**` — **マイグレーション不要**
- `src/lib/api/schemas.ts`、E2E（`tests/e2e/answer.spec.ts`）

---

## テスト（`@fixer` に実装を委譲、実行は Orchestrator）

### 4-1. `tests/db/weighting.test.ts` — `computeWeight` を全面書き換え

現行 6 ケース（`:4-31`）は新シグネチャで全滅するため置き換える。`pickByWeight` の describe（`:33-64`）は無変更。

固定基準時刻 `const NOW = new Date("2026-08-18T00:00:00Z")` を用意し、`daysAgo(n)` ヘルパーで `lastAnsweredAt` を作る。

1. `null` / `undefined` / `answered: 0` → `UNSEEN_WEIGHT`
2. **recency 単調性**: 同一 stats で 0日 < 1日 < 3.5日 < 7日、かつ 7日 == 30日（頭打ち）
3. **正解数の単調減少**: `correct` 1 → 3 → 5 で単調減、5 == 20（`MASTERY_CAP` 頭打ち）
4. **誤答数の単調増加**: 同一比率（例 2/4, 4/8, 8/16）で単調増、`MISS_CAP` で頭打ち
5. **直近誤答の下限**: `latestIncorrect: true` かつ 0 日経過でも recency 由来の押し下げが起きない（同 stats の `latestIncorrect: false` 版より必ず大きい）
6. **クランプ**: 熟知ケースが `WEIGHT_MIN`、最悪ケースが `WEIGHT_MAX` に張り付く
7. **`lastAnsweredAt: null` かつ `answered > 0`**（防御的パス）→ `RECENCY_FULL_DAYS` 相当 = 最大 recency
8. **未来時刻**（クロックスキュー）→ `elapsedDays` が 0 にクランプされ、0 日と同値
9. **代表値の数値検証**: 上の分布表から 3 ケースを `toBeCloseTo` で固定（0.10 / 1.09 / 14.82）

### 4-2. `tests/db/question-repository.test.ts` — 追加 2 ケース

既存の `pickWeightedRandomQuestion` describe（`:59-101`）に追加。`answerLogs.answeredAt` を明示指定して挿入する。

1. **秒 → ミリ秒変換の回帰テスト（★重要）**: 正誤実績が同一の問題 A・B を用意し、A の解答ログを 30 日前、B を「たった今」にする。決定的 rng で多数回抽選し **A が有意に多く選ばれる**ことを検証。×1000 を落とすと両者とも recency 最大になり差が消えるため、この 1 本がバグを検知する
2. **タイブレーク**: 同一 `answered_at` の正解ログと誤答ログを入れ、`id` の大きい方（後挿入）が「最新」として扱われることを検証

### 4-3. カバレッジ Tier（任意だが推奨）

`weighting.ts` は分岐が 1 本 → 5 本前後に増える。現状は Tier 3（`/lib/db/repository/.+\.ts$`、目標 75%）に含まれるだけで、リポジトリ全体の集計に薄まって穴が隠れうる。

`scripts/check-coverage-tiers.mjs` の Tier 1 patterns に `/\/lib\/db\/repository\/weighting\.ts$/` を追加する。**Tier のマッチは排他ではない**（`check-coverage-tiers.mjs:130` は各 Tier が独立に全ファイルを filter する）ため、`weighting.ts` は Tier 1 と Tier 3 の両方で二重に集計される。これは意図どおり（純粋ロジックとして 90% を個別に担保しつつ、Tier 3 の集計にも残す）。spec.md の Tier 一覧にも同じ注記を入れる。

スコープを絞りたい場合はこの 4-3 のみ落とせる（1・2・4-1・4-2 は独立して成立する）。

---

## 仕様書の更新（`openspec/specs/study/spec.md`）

`## Weighted Random Selection`（`:174-179`）を全面差し替え:

- **Unanswered:** 固定 `UNSEEN_WEIGHT = 12`
- **Answered:** `clamp(accuracyTerm × missBonus × masteryDecay × recency × latestMissMult, 0.1, 30)`
  - `accuracyTerm = 1 + 4 * (incorrect / answered)` — 比率軸（従来）
  - `missBonus = 1 + 0.5 * min(incorrect, 4)` — 絶対誤答回数
  - `masteryDecay = 1 / (1 + 0.35 * min(correct, 5))` — 絶対正解回数による減衰
  - `recency = 0.2 → 3.0` の線形ランプ（`answered_at` からの経過日数、7 日で頭打ち）。直近誤答時は下限 1.0
  - `latestMissMult = 2`（直近が誤答のとき）
- **Exclusion:** 直近 10 件（変更なし）
- **Pure logic module:** `src/lib/db/repository/weighting.ts`（`computeWeight(stats, now)` / `pickByWeight()`）。`now` は呼び出し側が 1 抽選につき 1 回確定させる

あわせて更新:

- `:53` の `GET /api/questions/random` の説明 — 「経過時間と正誤回数で重み付け」を追記
- `:190` の Unit tests 件数（`175 tests` → 実測値）
- Tier 一覧（4-3 を実施する場合）
- `codemap.md:26` / `src/lib/db/codemap.md:12` — 重み付けの軸が増えた旨を 1 行反映

---

## 変更対象ファイル

| ファイル                                       | 内容                                                          |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `src/lib/db/repository/weighting.ts`           | 定数追加、`WeightStats` 拡張、`computeWeight` 改訂            |
| `src/lib/db/repository/question-repository.ts` | `max(answered_at)` 取得、秒→ms 変換、タイブレーク、`now` 伝播 |
| `tests/db/weighting.test.ts`                   | `computeWeight` の describe を全面書き換え（9 ケース）        |
| `tests/db/question-repository.test.ts`         | 2 ケース追加                                                  |
| `scripts/check-coverage-tiers.mjs`             | Tier 1 に `weighting.ts` を追加（任意）                       |
| `openspec/specs/study/spec.md`                 | Weighted Random Selection / API 説明 / テスト件数 / Tier      |
| `codemap.md`, `src/lib/db/codemap.md`          | 1 行ずつ反映                                                  |

マイグレーション・API 契約・UI・E2E の変更はなし。

---

## 検証（Orchestrator が実行）

安い順に fail-fast:

```bash
bash scripts/check-spec-refs.sh
pnpm type-check:fast
pnpm lint:fast
pnpm test:coverage
node scripts/check-coverage-tiers.mjs
pnpm test:e2e
```

加えて手動確認:

1. **秒→ms 回帰の実証** — `question-repository.ts` の `new Date(ts * 1000)` を一時的に `new Date(ts)` に戻し、テスト 4-2-1 が**赤くなる**ことを確認してから戻す
2. **直近誤答の逆転防止の実証** — `recency = Math.max(1, recency)` の行を一時的に削除し、テスト 4-1-5 が**赤くなる**ことを確認してから戻す

コミットは論理単位で分割（重み計算 / リポジトリ配線 / テスト / 仕様書・codemap）、push は 1 回。

---

# 実施結果・検証（2026-08-18）

HEAD = `bc9e644`（本変更は未コミット）。実装は `@fixer` が担当し、以下の検証ゲートは Orchestrator が実行した。

## 実装内容とプランの一致確認

`src/lib/db/repository/weighting.ts` および `src/lib/db/repository/question-repository.ts` の差分は、プラン §1・§2 の記載と**完全に一致**。乖離なし。

- 定数 11 個の export、`WeightStats.lastAnsweredAt` 追加、`computeWeight(stats, now)` の 4 軸乗算 — プラン §1-1〜1-3 のとおり
- `const now = new Date()` の関数先頭確定、`max(answered_at)` 追加、`new Date(ts * 1000)`、`ORDER BY l2.answered_at DESC, l2.id DESC` — プラン §2 (a)〜(e) のとおり
- 非変更対象（`pickByWeight` / random route / 直近 10 件除外 / schema / migrations）は差分ゼロ — プラン §3 のとおり

## ゲート結果

| ゲート                                  | 結果                                          |
| --------------------------------------- | --------------------------------------------- |
| `bash scripts/check-spec-refs.sh`       | ✅ All spec.md file references are valid      |
| `pnpm type-check:fast`（tsgo）          | ✅                                            |
| `pnpm lint:fast`（oxlint）              | ✅                                            |
| `pnpm test`                             | ✅ **183 passed** / 35 files（175 → 183、+8） |
| `node scripts/check-coverage-tiers.mjs` | ✅ 全 7 Tier PASS                             |
| `pnpm test:e2e`                         | ✅ **38 passed**（32.9s）                     |
| `pnpm format:check`                     | ❌ → **修正済み**（下記）                     |

カバレッジ Tier 実測:

| Tier                            | 実測                      | 目標                |
| ------------------------------- | ------------------------- | ------------------- |
| Tier 1: Core domain logic       | 96.59%                    | 90%                 |
| Tier 2: API / LLM orchestration | 97.40%                    | 80%                 |
| Tier 2b: API client & utilities | 97.37%                    | 85%                 |
| Tier 3: Data access             | 91.95%                    | 75%                 |
| Tier 4: UI state management     | 94.44%（branches 90.32%） | 90%（branches 75%） |
| Tier 5: UI components           | 100.00%                   | 70%                 |
| Tier 6: Question management UI  | 93.75%                    | 85%                 |

`weighting.ts` 単体は statements 97.14% / branches 89.47%。未カバーの `:79` は `pickByWeight` の浮動小数点セーフティネットで、本変更以前からの既存の穴。

### `format:check` の失敗と対処

`.github/workflows/main.yml:37` で `pnpm format:check` が blocking で走るが、変更 4 ファイル（`weighting.ts` / `question-repository.ts` / 両テスト）が未整形だった。`lint-staged.config.js` が `oxfmt --write` を掛けるためコミット時には自動修正されるが、検証時点では CI 相当のゲートが赤。

`pnpm exec oxfmt --write` を対象ファイルに適用して解消し、整形後に `pnpm test` / `type-check:fast` / `lint:fast` を再実行して green を再確認した。

残存: 未追跡の `.claude/summaries/20260808-*.md` 1 件が未整形。本変更とは無関係のセッション要約ファイルのため対象外とする。

---

## 変異テストの結果 — テストの穴 2 件

プラン「検証」§手動確認 の手順に従い、実装を一時的に壊してテストが赤くなるかを実測した。**手動確認 1 は成功、手動確認 2 は失敗（テストが検知しなかった）。**

### ❌ 穴 ①: `recency` の下限 1.0 を消してもテストが通る（要修正）

`weighting.ts:53` の

```ts
if (stats.latestIncorrect) recency = Math.max(1, recency);
```

は「**さっき間違えた問題が最も出にくくなる**」という要望の逆転を防ぐ唯一の行。この行を削除して `tests/db/weighting.test.ts` を実行したところ **16 テスト全通過**（検知失敗）。

原因は `tests/db/weighting.test.ts:98-112`（`latestIncorrect floor`）の比較対象 `wCorrect` が `WEIGHT_MIN` クランプに張り付いていること。実測値:

| 値                                         | floor あり         | floor なし |
| ------------------------------------------ | ------------------ | ---------- |
| `wCorrect`（answered=4, incorrect=0, 0日） | 0.1000（クランプ） | 0.1000     |
| `wIncorrect`（同 stats, latestIncorrect）  | 0.8333             | **0.1667** |

アサーション `wIncorrect > wCorrect` は floor の有無にかかわらず成立してしまう。クランプが変異を隠している。

**是正案**: 相対比較をやめ絶対値で固定する。

```ts
expect(wIncorrect).toBeCloseTo(0.8333, 3);
```

（floor なしなら 0.1667 になるため確実に赤くなる。参考: プラン分布表の `4問2誤答・直近誤答・0日` も floor あり 7.059 / floor なし 1.412 と 5 倍差がつく）

### ❌ 穴 ②: `ORDER BY ..., l2.id DESC` を消してもテストが通る

`question-repository.ts:94` のタイブレークを削除して `tests/db/question-repository.test.ts` を実行 → **13 テスト全通過**（2/2 回）。

SQLite が偶然「後挿入行」を返すため、`uses id as tiebreaker when answered_at is identical` は正しい結果を主張してはいるが、その根拠が実装ではなく偶然になっている。同一秒に複数解答したときの非決定性を実際には固定できていない。

**是正案**: このテストは「実装を固定する」目的を果たせないため、`l2.id DESC` の有無で結果が変わるデータ配置（先に誤答・後に正解を挿入して期待値を反転させる等）に組み替えるか、SQL 文字列そのものを検証する方式へ変更する。

### ⚠️ 懸念 ③: 秒→ms 回帰テストは機能するが統計依存

`new Date(ts * 1000)` を `new Date(ts)` に戻して実行 → **3/3 回とも赤**（手動確認 1 は成功）。

ただし `favors the question answered longer ago` は実 `Math.random` の 50 回試行 + 閾値 60% で判定している。正常時 P(旧問題) ≈ 93.8% に対し、壊れた実装では両問題の recency が最大値に張り付き P = 50% になるため、**約 6% の確率で誤って通過**する（n=50, p=0.5 で 31 回以上が出る確率）。

**是正案**: 同ファイルのタイブレークテストと同じく `vi.spyOn(Math, "random").mockReturnValue(0.6)` で決定的にする。正常時は候補先頭（30 日前の問題）、壊れた実装では 2 番目が選ばれるため 100% の検知率になる。

あわせて、当該テストのコメント「With a deterministic rng that always picks the first candidate, sort candidates by weight descending」は実装と食い違っている（rng を固定しておらず、候補のソートもしていない）。決定的化に合わせて書き直す。

---

## その他の指摘

- `openspec/specs/study/spec.md` の Tier 1 行に、プラン §4-3 で求めた「`weighting.ts` は Tier のマッチが排他でないため Tier 1 と Tier 3 の**両方で二重に集計される**」旨の注記が入っていない。1 行追記が必要。
- `README.md:88` の差分（`shared_plan/IMPLEMENTATION_PLAN.md` → `shared_plan/01-IMPLEMENTATION_PLAN.md`）は本変更とは無関係で、`shared_plan` の連番リネームに追従したもの。作業開始前から working tree に存在した。

## 残タスク

1. 穴 ①（`recency` 下限の絶対値アサーション）— **推奨**。ロジックの要が無防備
2. 穴 ②（タイブレークテストの組み替え）
3. 懸念 ③（rng 固定 + コメント修正）
4. spec.md Tier 1 の二重集計注記
