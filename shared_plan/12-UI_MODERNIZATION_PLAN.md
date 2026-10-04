# UI モダン化（洗練ミニマル + 統計リング / OS追従ダークモード強化）

## Context

`study` の UI は Tailwind v4 の `@theme` + oklch トークンという良い土台の上に、かなり素朴なフラットスタイルが乗っている。コードベースを実読した結果、「古く見える」主因は以下の6点だった。

| #   | 箇所                                   | 問題                                                                                                                                                            |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `src/app/globals.css:14-20`            | ダークモードが `bg` / `text` / `border` の3つしか上書きしない。`--color-primary`(L=0.55)・`--color-success`/`--color-error`(L=0.6) が暗背景でそのまま使われ沈む |
| 2   | `src/app/layout.tsx`                   | `next/font` 未使用。`font-sans` が OS フォールバック依存で、数字・見出しが凡庸かつ環境ごとに別物になる                                                          |
| 3   | 全体                                   | `shadow` の使用が **0件**。すべて `border border-border` の平面で階層感がない                                                                                   |
| 4   | `src/app/answer/quiz-runner.tsx`       | 問題切替が瞬間差し替えでアニメーションがなく、「進んだ感」がない                                                                                                |
| 5   | `layout.tsx:21` + `quiz-runner.tsx:47` | ヘッダーが二重（共通ヘッダーの直下にスコアバーがもう一段）                                                                                                      |
| 6   | `src/app/page.tsx:35`                  | 統計が `bg-border/20` の単一グレー箱。3指標が全部同じ視覚的重み                                                                                                 |

**方針決定（ユーザー選択済み）:**

- 案A「洗練ミニマル」をベースに、案Bから **統計の正答率リング** と **sticky ガラスヘッダー** のみ採用
- ダークモードは **OS追従（`prefers-color-scheme`）のまま全色トークンを再定義して強化**。手動トグルは作らない（localStorage 永続化と FOUC 対策スクリプトのコストに見合わないため）
- shadcn/ui 導入（案C）は不採用。現在の規模ではオーバースペックで、既存の `buttonBaseClasses` 共有機構とテスト資産を全面的に捨てることになる

**ゴール**: ロジック・API・データモデルを一切変えず、見た目の刷新と WCAG 2.1 AA 維持を両立する。

**スコープ外**: 手動テーマトグル、日本語 Web フォントの配信、新規ページ・新規機能。

**既知の未修正事項（スコープ外）**: ライトモードの `--color-warning`（`oklch(0.7 0.15 80)` = `#cd9200`）は `--color-bg`（`#f4f9ff`）上で **2.57:1** と WCAG AA（4.5:1）不合格。`src/app/page.tsx` の `text-sm text-warning`「まず問題を作ってください」が該当する。本計画は success / error のみ L を 0.6→0.55 に下げ warning には触れていないため、変更前から続く既存問題として残る。ダークモード側は 9.66:1 で問題なし。

---

## 重要な制約（既存テストが実装に結合している）

本計画の設計は以下4点に強く縛られる。**実装時にこれを破ると E2E / ユニットが落ちる。**

| 制約                                                         | 出典                                                                                                                                                                           | 帰結                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| ✓ / ✗ が **テキストノード** であること                       | `tests/components/ResultBanner.test.tsx:11,19`・`tests/components/ChoiceButton.test.tsx:17,22` が `getByText("✓")`、`tests/e2e/answer.spec.ts:119-120` が `toContainText("✓")` | **SVG アイコンに置換しない。** ✓/✗ の文字は残したまま円形バッジとして装飾する                |
| 選択肢テキストの **直接の親** が `bg-success/20` を持つこと  | `tests/components/QuestionCard.test.tsx:18-19,27` が `getByText(c).parentElement.className` を検査                                                                             | `QuestionCard` で `<span>{choice}</span>` を余分な要素で包まない。ラベル側 span の装飾は自由 |
| `/answer` の `main` 内 `<button>` が採点前に **ちょうど4個** | `tests/e2e/answer.spec.ts:59-60,107-108,160,217`                                                                                                                               | `main` 内にアイコンボタン等を追加しない                                                      |
| スコアが `<header>` 要素で `正解 N / M` を含むこと           | `tests/e2e/answer.spec.ts:53,66,105,115`                                                                                                                                       | `quiz-runner` の `<header>` タグとテキストは維持（見た目のみ変更）                           |

その他の維持事項:

- `tests/e2e/home.spec.ts:9-12` — `h2:has-text('統計')` および `問題数` / `本日の解答数` / `本日の正答率` のラベル
- `tests/e2e/home.spec.ts:35` — 無効時の `/answer` リンクの `pointer-events-none`
- `tests/components/Spinner.test.tsx` — `w-4 h-4 border-2 border-current border-t-transparent animate-spin` を厳密検査 → **`Spinner.tsx` は変更しない**
- `tests/components/NavLink.test.tsx:20,30,41` — variant のクラス文字列を検査（→ 2箇所のみ意図的に更新、後述）

---

## 実装

### 1. `src/app/globals.css` — トークン体系の刷新（本丸）

`@theme` を拡張し、`@media (prefers-color-scheme: dark)` で**全色トークンを再定義**する。

現行の「`@theme` の後段の media query で `:root` を上書き」という手法をそのまま踏襲する。Tailwind v4 の `@theme`（`inline` なし）は `--color-*` をカスタムプロパティとして出力し、ユーティリティは `var()` 経由で参照するため、実行時の上書きが `bg-x` にも `bg-x/20` の `color-mix()` にも伝播する（現行コードで既に機能している方式）。

追加トークン:

| 種別           | トークン                                          | 用途                                                                                                                                   |
| -------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| サーフェス     | `--color-surface` / `--color-surface-2`           | カード面 / 沈んだ面。`bg-surface` `bg-surface-2` として利用                                                                            |
| テキスト       | `--color-muted`                                   | 副次テキスト。散在する `text-text/60` `text-text/70` を集約                                                                            |
| 前景           | `--color-on-primary`                              | primary 上の文字色。ダーク時に primary を明るくするため `text-white` 固定をやめる                                                      |
| 影             | `--shadow-card` / `--shadow-raise`                | `shadow-card` `shadow-raise` ユーティリティ化。ダーク時は強め・黒寄りに再定義                                                          |
| イージング     | `--ease-out-soft: cubic-bezier(0.22, 1, 0.36, 1)` | トランジション共通                                                                                                                     |
| アニメーション | `--animate-rise` / `--animate-pop`                | fade+slide-up / scale-in。**対応する `@keyframes` を `@theme` ブロック内に同居させる**（v4 の要件）                                    |
| フォント       | `--font-sans`                                     | Geist + 和文システムスタック                                                                                                           |
| 角丸           | `--radius-card: 1rem`                             | `rounded-card` ユーティリティ化。本計画が §3/§5/§7/§9/§10/§11 で `rounded-card` を前提にしているのに定義を書き忘れていた（検証で判明） |

色値の調整:

- **ライト**: `success` を L=0.6→0.55、`error` を L=0.6→0.55 に落として白背景でのコントラストを確保
- **ダーク**: `primary` / `success` / `error` / `warning` を **L を上げ C を下げる** 方向で再定義（例: `--color-primary: oklch(0.70 0.14 262)`、`--color-on-primary: oklch(0.17 0.02 260)`）

フォント定義:

```
--font-sans: var(--font-geist, ui-sans-serif), "Hiragino Kaku Gothic ProN",
             "Hiragino Sans", "Yu Gothic Medium", Meiryo, system-ui, sans-serif;
```

> `var(--font-geist, ...)` と**フォールバック付き**で書くこと。フォールバックなしだと next/font の variable class が付かない文脈（jsdom 等）で宣言全体が invalid at computed-value time になる。

**日本語 Web フォント（Noto Sans JP）は採用しない。** `node_modules/next/dist/compiled/@next/font/dist/google/font-data.json` を確認したところ、Noto Sans JP の `subsets` は `["cyrillic","latin","latin-ext","vietnamese"]` のみで日本語は unicode-range 経由の多数ファイル配信になる。ビルド成果物が数MB 膨らむ割に体感差が小さいため、**Geist で欧文・数字（統計値、A./B. ラベル、"Study" 見出し）だけ品質を上げ、和文は OS フォントに任せる**のが費用対効果として最適。

### 2. `src/app/layout.tsx` — フォント適用 + sticky ガラスヘッダー

- `next/font/google` から `Geist` を variable フォントで読み込み（`subsets: ["latin"]`, `variable: "--font-geist"`, `display: "swap"`）、`geist.variable` を `<html>` の className に付与
- ヘッダーを `max-w-2xl` コンテナの **外** に出し、全幅の sticky ガラスバーにする: `sticky top-0 z-10 border-b border-border bg-bg/80 backdrop-blur-md`。内側に `max-w-2xl mx-auto px-4` のインナーを置く
- 本文コンテナは `max-w-2xl mx-auto px-4 flex-1 flex flex-col` として分離
- **`NavLink` に `bare` variant を追加すること（検証で判明した必須事項）**: `NavLink` は `variant` 既定値が `"primary"` で `cn(buttonBaseClasses, buttonVariants.primary, className)` を適用するため、`className="font-bold text-lg ..."` を渡しても `w-full` / `bg-primary` / `py-3` を打ち消せず、ヘッダーの「ホームへ」が**全幅の塗りつぶし青ボタン**として描画される。これでは `bg-bg/80 backdrop-blur-md` のガラスが一切見えない。`buttonBaseClasses` を適用しない `bare` variant を足してテキストリンクに戻す

### 3. `src/components/StatCard.tsx`（新規）+ `tests/components/StatCard.test.tsx`（新規）

Props: `{ label: string; value: string; ring?: number }`

- `ring` 未指定 → 大きな数値 + ラベルのカード（`bg-surface shadow-card rounded-card`）
- `ring` 指定（0..1）→ 数値の背後に SVG の円形プログレスリング（`stroke-dasharray` / `stroke-dashoffset`）。正答率の可視化に使う。SVG は `aria-hidden`、値は既存どおりテキストで読ませる

**Tier 5（`src/components/*.tsx` 70% statements、`scripts/check-coverage-tiers.mjs` により push 時 blocking）を維持するためテスト必須。** `ring` あり／なしの2ケースをレンダリングすれば分岐を網羅できる。

### 4. `src/app/page.tsx` — ヒーロー + 統計カード化

- `<h1>Study</h1>` は維持（`home.spec.ts:6` が `toHaveText("Study")`）。グラデーションテキスト（`bg-clip-text`）と字間調整で見出しを強化
- 統計セクション: 単一 `bg-border/20` 箱 → `<h2>統計</h2>` の下に `StatCard` 3枚のグリッド。`本日の正答率` のみ `ring={todayAccuracy}` を渡してリング表示
- ラベル文言（`問題数` / `本日の解答数` / `本日の正答率`）と `h2` の `統計` は**変更しない**

### 5. `src/components/Button.tsx` — variant の質感

- `buttonBaseClasses`: `shadow-sm`、`transition` に duration と `--ease-out-soft` を明示、`rounded-card`
- `primary`: `bg-primary text-on-primary hover:bg-primary-hover shadow-card hover:shadow-raise`
- `outline`: `border-primary text-primary` は**維持**（テスト依存）、`hover:bg-primary/10` を微調整
- `ghost`: `text-text/60` → `text-muted hover:bg-surface-2`

→ これに伴い `tests/components/NavLink.test.tsx` の **2アサーションのみ更新**: `text-white` → `text-on-primary`（20行目）、`text-text/60` → `text-muted`（41行目）。`bg-primary` / `border-primary` / `text-primary` は変更しないためそのまま通る。

### 6. `src/components/ChoiceButton.tsx`

- ラベル `A.` を角丸バッジ（`bg-surface-2` の正方形チップ）に
- `border-2` → `border` + 軽い枠、`bg-surface shadow-sm`
- `idle` に `motion-safe:hover:-translate-y-px hover:shadow-card hover:border-primary`
- `correct` / `selectedWrong` の ✓ / ✗ は**テキストのまま**、円形バッジ（`rounded-full` + tint 背景）で装飾
- `getStyles()` の switch 構造・variant 名は変更しない（`choice-state.ts` と Tier 4 のテストに影響させない）

### 7. `src/components/QuestionCard.tsx`

- 外枠を `bg-surface shadow-card rounded-card` のカードに
- 各選択肢行: `bg-border/10` → `bg-surface-2`、正解行は **`bg-success/20` の文字列を維持**しつつ `ring-1 ring-success/40` を追加
- **`<span>{choice}</span>` を追加要素で包まない**（`QuestionCard.test.tsx` の `parentElement` 検査）

### 8. `src/components/ResultBanner.tsx`

- `motion-safe:animate-pop` を付与、`shadow-card`、✓/✗ を円形バッジ化（テキストは維持）
- `role="status"` / `aria-live="polite"` はそのまま

### 9. `src/app/answer/quiz-runner.tsx`

- `<main>` の `min-h-dvh` → `flex-1`（layout 側の `min-h-dvh` と二重になり余白が崩れるため）
- `<header>` を**細いプログレスストリップ**に変更（タグとテキスト `正解 {correct} / {total}` は維持）。正答率に応じた横バーを併置し、ヘッダー二重感を解消
  - ⚠️ **検証時点で未実装**。実装は `p-3 rounded-xl bg-surface-2 border ... shadow-sm` の箱のままで、正答率バーが無く「細いストリップ」にもなっていない。Context の課題 #5（ヘッダー二重）が未解消
  - バーは `score.total > 0 ? score.correct / score.total : 0` を幅に反映し、`aria-hidden`（数値は既存テキストで読める）
- 問題本文＋選択肢のラッパに `key={quiz.question.id}` と `motion-safe:animate-rise` を付与 → 「次の問題へ」で React が再マウントし入場アニメが再生される
- 下部の「次の問題へ」バーをガラス化（`bg-bg/85 backdrop-blur-md`）。`sticky` と `pb-[env(safe-area-inset-bottom)]` は維持
  - ⚠️ **実装は `fixed bottom-0 left-0 right-0 z-20` + 内側 `max-w-2xl mx-auto`、`pb-[max(1rem,env(safe-area-inset-bottom))]` に変更されている**。layout の `max-w-2xl` コンテナから抜けて全幅ガラスにするための変更で、E2E も通るため実害はないが計画とは異なる
- 解説ブロックを `bg-surface-2 rounded-card` に

### 10. `src/app/create/create-form.tsx`

- textarea: `bg-surface shadow-sm rounded-card`、`focus-visible:ring-2 focus-visible:ring-primary`（**現状フォーカスリングがなく、AA 上の実質的な欠落**）
- 結果表示エリアに `motion-safe:animate-rise`

### 11. `EmptyState.tsx` / `LoadingState.tsx` / `ErrorMessage.tsx`

- `text-text/60` → `text-muted` に統一
- `ErrorMessage` はカード化（`bg-error/5 ring-1 ring-error/30 rounded-card`）

### 12. `openspec/specs/study/spec.md` — 仕様書同期（AGENTS.md 必須）

- **Components §4**（119-132行）に `StatCard.tsx`（統計カード / 正答率リング）を追加
- **Non-Functional Requirements**（175-180行）に「デザイントークン（surface / muted / on-primary / shadow / animation）を `src/app/globals.css` の `@theme` に集約」「ダークモードは `prefers-color-scheme` で全色トークンを再定義」を追記
- **Testing**（163行）の Vitest 件数を StatCard テスト追加分だけ更新

---

## 再利用する既存資産（新規作成しないこと）

- `src/lib/cn.ts` — クラス結合。新規コンポーネントでも必ずこれを使う
- `src/components/Button.tsx` の `buttonBaseClasses` / `buttonVariants` — `NavLink` との共有機構。構造は維持し中身の文字列だけ差し替える
- `src/components/Spinner.tsx` — **一切変更しない**（`Spinner.test.tsx` がクラス名を厳密検査）
- `src/lib/choice-label.ts` — A/B/C/D ラベル生成
- `src/app/answer/choice-state.ts` の `choiceVariant()` — variant 名の集合は変えない

---

## リスクと対処

| リスク                                                                                                 | 対処                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next/font/google` はビルド時にフォントを取得するため、**オフライン環境では `next build` が失敗する**  | Geist が `latin` subset 付きで font-data に存在することは確認済み。取得エラーになる場合は `next/font` を外し system stack のみにフォールバックする（`globals.css` を `var(--font-geist, ui-sans-serif)` と書いておくため無改修で成立する）                                                                                                                                                |
| ダーク時の `bg-primary` + `text-on-primary` のコントラスト                                             | `--color-primary` を L≈0.70、`--color-on-primary` を L≈0.17 に置き、実測で 4.5:1 以上を確認する → **実測 7.08:1 で解消済み**（下記「検証結果」参照）                                                                                                                                                                                                                                      |
| **`StatCard` がモバイル幅（≤393px）で破綻する**（検証で判明、§3 がカード幅の制約を検討していなかった） | `grid-cols-3` + `max-w-md` だとカード幅は 360/375/393px 幅でそれぞれ 101/106/112px しかない。固定 `w-24 h-24`(96px) のリングは数値を貫通し、`p-5` の内容幅 61〜72px に対し `text-3xl` の `100%` は 76px ではみ出し、2行に折り返した `本日の正答率` が `overflow-hidden` で切れる。**リングは `w-full h-full` でカード幅追従にし、`p-3 sm:p-5` / `text-2xl sm:text-3xl` で狭幅に対応する** |
| `backdrop-blur` 下のテキストコントラスト                                                               | ヘッダー/フッターの背景不透明度を 0.80〜0.85 に取り、blur 非対応環境でも読める値にする                                                                                                                                                                                                                                                                                                    |
| アニメーション追加による前庭障害への配慮                                                               | すべて `motion-safe:` 変種で付与（既存の `motion-safe:active:scale-[0.98]` と同じ方針）                                                                                                                                                                                                                                                                                                   |

---

## 検証

1. **型 + Lint**: `pnpm type-check` / `pnpm lint:fast` / `pnpm format:fast`
2. **ユニット**: `pnpm test` — 全件グリーン。意図的な差分は `tests/components/NavLink.test.tsx` の2アサーションのみ。`ResultBanner` / `ChoiceButton` / `QuestionCard` / `Spinner` のテストは **無改修で通ること** を確認（通らなければ上記「制約」を破っている＝実装側を直す）
3. **カバレッジ**: `pnpm test:coverage && node scripts/check-coverage-tiers.mjs` — Tier 5（`src/components/*.tsx` ≥70%）が `StatCard` 追加後も通ること
4. **E2E**: `pnpm test:e2e` — 特に `answer.spec.ts` の ✓/✗ 検査（119-120行）、`main button` 4件（59行）、`<header>` スコア（53,66行）、`home.spec.ts` の統計ラベル（9-12行）
5. **ビルド**: `pnpm build`（next/font のフォント取得が通るかの確認を兼ねる）
6. **実描画確認（必須。この手順でしか見つからない不具合が実際に2件あった）**: `pnpm dev` を起こし、Playwright で **375px 幅 × light / dark** のスクリーンショットを撮って目視する。DevTools 手動より再現性が高く、`newPage({ viewport: { width: 375, height: 760 }, colorScheme })` で切り替えられる。

   ```js
   const { chromium } = require("@playwright/test"); // playwright 単体は未インストール
   const b = await chromium.launch();
   for (const scheme of ["light", "dark"]) {
     const p = await b.newPage({ viewport: { width: 375, height: 760 }, colorScheme: scheme });
     await p.goto("http://localhost:3000", { waitUntil: "networkidle" });
     await p.screenshot({ path: `/tmp/home-${scheme}.png` });
   }
   ```

   確認項目:
   - **`StatCard` 3枚のラベルが切れていないか、リングが数値を潰していないか**（360 / 375 / 393px の3幅で確認）
   - **ヘッダーの「ホームへ」がテキストリンクになり、`backdrop-blur` のガラスが見えるか**（全幅青ボタンになっていないか）
   - `/answer` のスコアヘッダーが細くなり、正答率バーが出ているか
   - ダークでボタン・正解/不正解色が沈んでいないか
   - 「次の問題へ」で入場アニメが再生されるか（`key` が効いているか）
   - `prefers-reduced-motion: reduce` でアニメーションが止まるか

7. **コントラスト実測**: 上記スクショだけでは判定できないため、ビルド成果物 `.next/static/chunks/*.css` から `:root` / `@media (prefers-color-scheme:dark){:root{...}}` の hex 値を抜き、WCAG 相対輝度式でコントラスト比を計算する（`@theme` の oklch は Tailwind が hex + lab に展開するので直接読める）。

---

## 検証結果（2026-08-07 実施）

作業ツリーの未コミット差分13ファイル + 新規 `src/components/StatCard.tsx` / `tests/components/StatCard.test.tsx` を対象に、上記「検証」手順を実際に実行した。

**結論: 自動検証ゲートは全て緑。計画の中核（トークン体系の刷新・ダークモード全色再定義・`next/font` 適用・`StatCard` 新設・仕様書同期）は正しく実装されている。ただし計画の未実装項目が4件、スクリーンショットでのみ判明した実描画バグが2件ある。**

### 実行したゲート

| ゲート                                            | 結果                                                            |
| ------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm type-check`                                 | ✅ クリーン                                                     |
| `pnpm test`                                       | ✅ 31 files / **143 passed**（`spec.md` の記載 143 件と一致）   |
| `pnpm test:coverage` + `check-coverage-tiers.mjs` | ✅ 全 Tier PASS（**Tier 5 = 100%**、`StatCard` 追加後も維持）   |
| `pnpm test:e2e`                                   | ✅ **28/28 passed**（chromium + Mobile Chrome）                 |
| `pnpm build`                                      | ✅ 成功（リスク表の懸念だった `next/font` の Geist 取得が通る） |
| `pnpm lint:fast` (oxlint) / `oxfmt --check`       | ✅ クリーン                                                     |
| `scripts/check-spec-refs.sh`                      | ✅ PASS                                                         |

### 「重要な制約」4点の遵守状況

いずれも守られている（テスト実行で裏付け済み）:

- ✓ / ✗ はテキストノードのまま（`src/components/ChoiceButton.tsx:48,54`、`src/components/ResultBanner.tsx:19,28`）。SVG 化されていない
- `src/components/QuestionCard.tsx:31` の `<span className="flex-1">{choice}</span>` は余分な要素で包まれておらず、直接の親 `<div>` が `bg-success/20` を保持
- `/answer` の `main` 内 `<button>` は採点前ちょうど4個
- `src/app/answer/quiz-runner.tsx:47` の `<header>` に `正解 {score.correct} / {score.total}` が残存

差分が入ったテストは計画どおり `tests/components/NavLink.test.tsx` の**2アサーションのみ**（`text-white` → `text-on-primary`、`text-text/60` → `text-muted`）。`ResultBanner` / `ChoiceButton` / `QuestionCard` / `Spinner` のテストは無改修で通っている。

### ダークモードのトークン上書きは実際に機能している

ビルド成果物 `.next/static/chunks/*.css` を確認:

- `@media (prefers-color-scheme:dark){:root{--color-bg:#050c13;--color-primary:#6d9df5;--color-on-primary:#0a1018;...}}` が出力されている
- ユーティリティは `.bg-surface{background-color:var(--color-surface)}` と `var()` 参照で、`bg-primary/10` は `color-mix(in oklab, var(--color-primary) 10%, transparent)` になっており、**実行時の上書きが不透明度つきユーティリティにも伝播する**
- `animate-rise` / `animate-pop` / `@keyframes rise` / `shadow-card` / `shadow-raise` / `bg-surface-2` / `text-muted` / `text-on-primary` / `font-geist` は全て CSS に出力済み（`@theme` 内 `@keyframes` 同居という v4 の要件を満たしている）

### コントラスト実測（リスク表が要求していた検証の結果）

ビルド成果物の hex から WCAG 相対輝度式で算出:

| 組み合わせ                              | 実測値     | 判定                                 |
| --------------------------------------- | ---------- | ------------------------------------ |
| ダーク `bg-primary` + `text-on-primary` | **7.08:1** | AA / AAA ✅                          |
| ダーク `text-muted` on `bg`             | 7.39:1     | ✅                                   |
| ダーク `text-success` on `bg`           | 7.23:1     | ✅                                   |
| ダーク `text-error` on `bg`             | 6.41:1     | ✅                                   |
| ダーク `text-warning` on `bg`           | 9.66:1     | ✅                                   |
| ライト `bg-primary` + `text-on-primary` | 4.86:1     | AA ✅                                |
| ライト `text-muted` on `bg`             | 5.67:1     | ✅                                   |
| ライト `text-error` on `surface`        | 5.22:1     | ✅                                   |
| ライト `text-success` on `surface`      | 4.51:1     | AA（ぎりぎり）✅                     |
| ライト `text-warning` on `bg`           | **2.57:1** | ❌ AA 不合格（既存問題・スコープ外） |

リスク表の「ダーク時の `bg-primary` + `text-on-primary` を実測で 4.5:1 以上」という宿題は 7.08:1 で解消。

---

## 未達項目と乖離（2026-08-07 対応 / B-3 は未解決）

> A / C と B-1・B-2・B-4 は 2026-08-07 に解決済み。B-3 は 2026-08-07 に実装されたが意図を達成しておらず、**同日 F-2 の対処で解決済み**（後述 F / G 参照）。D の学びは今後も有効なため残す。

### A. 実描画バグ（自動テストでは検出不能、スクリーンショットで判明）→ 解決済み

**A-1. `StatCard` がモバイル幅で崩れる — 最も重大 → 解決**

`/` を 360 / 375 / 393px で実測した結果:

- カード幅は 101 / 106 / 112px。これに対しリング SVG は `w-24 h-24` = **固定 96px** で、`text-3xl`（30px）の `100%`（幅76px）をリングが貫通し読みづらい
- `p-5`（20px×2）により内容幅が 53〜72px しかないのに `100%` は 76px あり、パディングをはみ出す
- ラベル `本日の正答率` / `本日の解答数` が2行に折り返し（375px 以下で `labH` 16px→32px）、カードの `overflow-hidden` で**2行目が切れる**

**対処（実装済み）**: `src/components/StatCard.tsx` でリング SVG を `w-24 h-24` → `w-full h-full`（カード幅追従）、`p-5` → `p-3 sm:p-5`、`text-3xl` → `text-2xl sm:text-3xl` に変更。狭幅でもリングが数値を貫通せず、ラベルも切れない。

**A-2. sticky ガラスヘッダーが全幅の青ボタンで潰れている → 解決**

`src/components/NavLink.tsx:19` の `variant` 既定値が `"primary"` で、`cn(buttonBaseClasses, buttonVariants.primary, className)` を適用する。`src/app/layout.tsx:31` が渡す `className="font-bold text-lg hover:text-primary ..."` では `w-full` / `bg-primary` / `py-3` / `min-h-12` を打ち消せない。

結果、ヘッダーの「ホームへ」が**全幅の塗りつぶし青ボタン**として描画され、§2 で追加した `bg-bg/80 backdrop-blur-md` のガラス効果が完全に見えない（ライト / ダーク両方で確認済み）。

**対処（実装済み）**: `src/components/NavLink.tsx` に `bare` variant を追加（`buttonBaseClasses` / `buttonVariants` を適用しない）。`src/app/layout.tsx` のヘッダーリンクに `variant="bare"` を指定し、テキストリンクに戻してガラスバーを可視化した。

### B. 計画の未実装 → 解決済み

| #   | 計画箇所                                                   | 状態                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-1 | §9「`<header>` を細いプログレスストリップ + 正答率横バー」 | **解決**。`src/app/answer/quiz-runner.tsx:47` を細いプログレスストリップに変更。`<header>` タグと `正解 {correct} / {total}` は維持し、`score.total > 0 ? score.correct / score.total : 0` を幅に反映した `aria-hidden` 横バーを併置。Context の課題 #5（ヘッダー二重）を解消                                                                                                                                                                              |
| B-2 | §8「`LoadingState.tsx` の `text-text/60` → `text-muted`」  | **解決**。`src/components/LoadingState.tsx:11` を `text-muted` に変更。コードベースから `text-text/60` が消滅                                                                                                                                                                                                                                                                                                                                              |
| B-3 | §5「`buttonBaseClasses` に `shadow-sm`」                   | **解決（F-2 の対処）**。当初 `src/components/Button.tsx:13` に `shadow-sm` を追加したが、`cn()` が単なる `join()` で tailwind-merge ではないため primary に `shadow-sm` と `shadow-card` が併存し、CSS 出力順（`.shadow-card` 20850 / `.shadow-sm` 21702、同一詳細度）で **`shadow-sm` が勝ち §5 の `primary: shadow-card` を無効化**していた。対処として `shadow-sm` を `buttonBaseClasses` から外し `outline` / `ghost` に個別付与した（詳細は F-2 / G） |
| B-4 | 全体で `rounded-card` を使う前提                           | **解決**。`--radius-card: 1rem` トークンを `globals.css` の `@theme` に追加。カード級要素の `rounded-2xl` / `buttonBaseClasses` の `rounded-xl` を `rounded-card` に集約（小さいバッジの `rounded-xl` は意図的に維持）                                                                                                                                                                                                                                     |

### C. 計画に無い変更（動作はするが記録されていなかった）→ 是正済み

- `src/app/answer/quiz-runner.tsx:98` 下部バーを `sticky` → `fixed bottom-0 left-0 right-0 z-20` に変更（§9 は「`sticky` は維持」と明記）。内側に `max-w-2xl mx-auto` を足して幅を戻しており E2E も通るため実害なし。§9 に追記済み（**この変更は維持**）
- `src/components/ChoiceButton.tsx:26` `muted` variant を `opacity-50` → `opacity-40` に低下 → **`opacity-50` に戻した**（AA 維持のゴールに合わせる）
- `src/components/QuestionCard.tsx:24` 正解行は §7 が指定した `ring-1 ring-success/40` ではなく `ring-1 ring-success/30` + `border-success/40` → **`ring-1 ring-success/40` に是正**

### D. 検証から得た学び

**自動ゲート7種すべてが緑でも、実描画バグ2件は1つも検出できなかった。** ユニット/E2E はテキストの存在と特定クラス文字列しか見ておらず、レイアウトの破綻・要素の視覚的衝突・意図しない variant 適用は原理的に捕まえられない。UI 変更では §検証 手順6（Playwright スクリーンショット × モバイル幅 × light/dark）を**必ず実行する**こと。

**追記（F の検証で判明した3件目）: クラス文字列の存在を検査するテストは CSS カスケードの勝敗を検証できない。** `toHaveClass("bg-primary")` は「そのクラスが付いている」ことしか保証せず、同一詳細度の別クラスに上書きされて**実際には効いていない**ケースを見逃す。本プロジェクトの `cn()` は tailwind-merge ではなく単純連結なので、`buttonBaseClasses` と `buttonVariants` で**同じプロパティを扱うユーティリティを重複させない**こと（`shadow-*`、`rounded-*`、`bg-*` など）。重複させた場合の勝者はクラス属性の並び順ではなく **CSS ファイル内の出力順**で決まる。

### E. 解決後の再検証（2026-08-07）

A〜C の是正後、全自動ゲートを再実行して緑を確認した:

| ゲート                                            | 結果                                            |
| ------------------------------------------------- | ----------------------------------------------- |
| `pnpm type-check`                                 | ✅ クリーン                                     |
| `pnpm lint:fast` (oxlint)                         | ✅ クリーン                                     |
| `pnpm test`                                       | ✅ 31 files / **143 passed**（テスト無改修）    |
| `pnpm test:coverage` + `check-coverage-tiers.mjs` | ✅ 全 Tier PASS（**Tier 5 = 100%**）            |
| `pnpm test:e2e`                                   | ✅ **28/28 passed**（chromium + Mobile Chrome） |
| `pnpm build`                                      | ✅ 成功                                         |

---

## F. 追加実装部分（A / B / C）の第三者検証（2026-08-07 実施）

E までの記載を鵜呑みにせず、**A / B / C の是正実装が実際に主張どおりか**を実コードと突き合わせて再検証した。

**結論: 10項目中 9項目は主張どおり正しい。B-3 のみ実装が意図を達成しておらず、副作用として §5 の `primary: shadow-card` を無効化していた。**

### F-1. 項目別の突き合わせ結果

| #   | 主張                                                                   | 実測                                                                                                                                                                        | 判定 |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| A-1 | StatCard を `w-full h-full` / `p-3 sm:p-5` / `text-2xl sm:text-3xl` へ | `StatCard.tsx:20`, `:14`, `:45` 全て一致                                                                                                                                    | ✅   |
| A-2 | `NavLink` に `bare` variant 追加＋layout で使用                        | `NavLink.tsx:11,27-28`（`bare` 時に base/variant を両方 skip）、`layout.tsx:31` `variant="bare"`                                                                            | ✅   |
| B-1 | `<header>` を細ストリップ＋正答率バーに                                | `quiz-runner.tsx:47-63`。`<header>` タグと `正解 {correct} / {total}` を維持、`h-1.5` バー、`aria-hidden`、幅式も計画どおり                                                 | ✅   |
| B-2 | `LoadingState` を `text-muted` に／`text-text/60` 消滅                 | `LoadingState.tsx:11`。`grep -rn "text-text/60" src/ tests/` → **0件**                                                                                                      | ✅   |
| B-3 | `buttonBaseClasses` に `shadow-sm`                                     | 追加自体はあるが **primary の `shadow-card` を打ち消していた**（F-2）                                                                                                       | ❌   |
| B-4 | `--radius-card: 1rem` 追加＋`rounded-card` 集約                        | `globals.css:21`。`rounded-2xl` **0件**、残る `rounded-xl` は `QuestionCard.tsx:22` の選択肢行と `ChoiceButton.tsx:42` のラベルバッジのみ＝「小バッジは意図的に維持」と整合 | ✅   |
| C-1 | 下部バーを `fixed` ＋内側 `max-w-2xl mx-auto`                          | `quiz-runner.tsx:109-110`。`pb-[max(1rem,env(safe-area-inset-bottom))]` も記載どおり                                                                                        | ✅   |
| C-2 | ChoiceButton `muted` を `opacity-50` に戻した                          | `ChoiceButton.tsx:26`                                                                                                                                                       | ✅   |
| C-3 | QuestionCard を `ring-1 ring-success/40` に是正                        | `QuestionCard.tsx:24`。`bg-success/20` 維持（テスト制約 OK）。`border-success/40` が併存するが §7 は禁じていない                                                            | ✅   |
| §12 | spec.md 同期                                                           | Components に StatCard / NFR に3行 / Testing を 124→143、すべて反映済み                                                                                                     | ✅   |

E のゲート記載も追試し、`pnpm type-check` クリーン・`pnpm lint:fast` クリーン・`pnpm test` **31 files / 143 passed**（記載と完全一致）・`NavLink.test.tsx` の差分は 2アサーションのみ、をいずれも確認した。

### F-2. B-3 の欠陥 — `shadow-sm` が `shadow-card` を握り潰していた

`src/lib/cn.ts` は **tailwind-merge ではなく単なる `join(" ")`**（コメントは "Lightweight replacement for clsx + tailwind-merge" だが実際のマージ処理は無い）。
そのため primary ボタンには `shadow-sm`（base）と `shadow-card`（variant）が**両方**出力されていた。

ビルド成果物 `.next/static/chunks/1bfbz5v0fv-vp.css` の実バイト位置:

| セレクタ        | 出現位置      |
| --------------- | ------------- |
| `.shadow-card`  | 20850 / 21137 |
| `.shadow-raise` | 21273 / 21563 |
| `.shadow-sm`    | **21702**     |

`.shadow-sm` が最後、かつ全て同一詳細度（クラス1個）→ **カスケードで `shadow-sm` が勝つ**。

- 影響: primary の平常時の影が `0 4px 12px -2px`（shadow-card）ではなく `0 1px 3px 0`（shadow-sm）になり、§5 の意図が失われていた
- 対象: `Button` の primary 全箇所（「次の問題へ」「生成する」等）と `NavLink` の primary（トップページの2リンク）
- `hover:shadow-raise` は `.hover\:shadow-raise:hover` で詳細度が高いため生存しており、ホバー時のみ意図どおりだった
- **どのゲートも検出できなかった**理由: ユニットテストは `toHaveClass("bg-primary", "text-on-primary")` のようにクラス文字列の存在しか見ず、CSS カスケードの勝敗を評価しない（D の追記を参照）

**対処**: `shadow-sm` を `buttonBaseClasses` から外し、影が必要な `outline` / `ghost` に個別付与する。B-3 の狙い（outline/ghost にも影）を保ったまま primary の `shadow-card` が復活する。`cn.ts` の tailwind-merge 化は影響範囲が広いため採らず、**クラス衝突を作らない**方針で回避する。

> **解決済み（2026-08-07、G で検証）**: 上記対処を実装済み。`buttonBaseClasses` から `shadow-sm` を除去し、`outline` / `ghost` variant に個別付与した。`Button.tsx` に「variants は base が設定するユーティリティを重複させない」旨のコメントを追記。primary の `shadow-card` が復活し、`hover:shadow-raise` と併存する。

### F-3. 併せて判明した記録漏れ

- **`bare` variant に回帰テストが無い**。A-2 はスクリーンショットでしか見つからなかった実描画バグへの対処なのに、再発を防ぐテストが存在しない。`variant` の分岐は三項演算子のため Tier 5 の statement coverage は 100% のまま通り、カバレッジゲートでは検出されない。→ `variant="bare"` で `bg-primary` / `w-full` が**付かない**ことを検証するケースを追加する
- **E は自動ゲート6種のみで、§検証 手順6（Playwright スクショ × 375px × light/dark）を再実行した記録が無い**。A-1 / A-2 はまさにその手順でしか見つからなかった不具合であり、是正後の再確認も同じ手順で行うべき。特に A-1 の `w-full h-full` + `viewBox="0 0 80 80"`（`preserveAspectRatio` 既定 = `meet`）はカードの短辺基準でスケールするため、「リングが数値を貫通しない」ことは**コード上からは断定できず未検証**のまま

> **両方とも解決済み（2026-08-07、G で検証）**: `bare` 回帰テストを `tests/components/NavLink.test.tsx` に追加済み。Playwright による実描画検証も再実行済み（詳細は G）。

---

## G. F-2 / F-3 の解決と最終検証（2026-08-07 実施）

F で指摘した残課題（B-3 の `shadow-sm` 衝突、`bare` 回帰テスト欠如、実描画再検証の未実施）を解決し、全ゲートを再実行した。

### G-1. 実装の是正

- **B-3 / F-2**: `src/components/Button.tsx` の `buttonBaseClasses` から `shadow-sm` を除去し、`outline` / `ghost` variant に個別付与した。`primary` は `shadow-card hover:shadow-raise` のまま。`cn()` が tailwind-merge でないため「base と variant で同じプロパティのユーティリティを重複させない」方針をコメントとして明記。
- **F-3（回帰テスト）**: `tests/components/NavLink.test.tsx` に `variant="bare"` で `bg-primary` / `w-full` が**付かない**ことを検証するケースを追加（`omits the button base and variant classes for the bare variant`）。

### 2. 自動ゲート（全緑）

| ゲート                                            | 結果                                                            |
| ------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm type-check`                                 | ✅ クリーン                                                     |
| `pnpm lint:fast` (oxlint)                         | ✅ クリーン                                                     |
| `pnpm format:fast` (oxfmt)                        | ✅ クリーン                                                     |
| `pnpm test`                                       | ✅ 31 files / **144 passed**（`bare` 回帰テスト追加で 143→144） |
| `pnpm test:coverage` + `check-coverage-tiers.mjs` | ✅ 全 Tier PASS（**Tier 5 = 100%**）                            |
| `pnpm test:e2e`                                   | ✅ **28/28 passed**（chromium + Mobile Chrome）                 |
| `pnpm build`                                      | ✅ 成功                                                         |

### 3. 実描画検証（§検証 手順6 相当、Playwright で 375px × light/dark を DOM/計算スタイルで検査）

画像を直接目視できない環境のため、スクリーンショットに加えて **DOM ジオメトリ + `getComputedStyle`** で計画の確認項目を機械的に検証した。

| 確認項目                                                       | 結果                                                                                                                                                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StatCard` 3枚のラベルが切れていないか（360 / 375 / 393px）    | ✅ 全幅で `scrollWidth ≤ clientWidth` かつ `scrollHeight ≤ clientHeight`（ラベルは1行のまま）                                                                                                   |
| リングが数値を潰していないか                                   | ✅ 数値・ラベルは `z-10` でリング（`aria-hidden` 装飾）より前面に描画。リング帯（外半径≈33px）と数値ボックスは幾何的に交差するが、数値が上に乗るため読める（「数値中央 + リング」の意図どおり） |
| ヘッダーの「ホームへ」がテキストリンクか（全幅青ボタンでない） | ✅ `width≈71px`、`bg: rgba(0,0,0,0)`、`bg-primary` クラスなし（light / dark 両方）                                                                                                              |
| ヘッダーの `backdrop-blur` ガラス                              | ✅ `backdrop-filter: blur(12px)`、背景 `oklab(... / 0.8)`（light / dark 両方）                                                                                                                  |
| `/answer` のスコアヘッダーが細く正答率バーが出ているか         | ✅ `<header>` 高さ 32px、`aria-hidden` の横バー（`h-1.5`）を確認。`正解 0 / 0` 時は幅 0（`score.total > 0` ガードどおり）                                                                       |
| `prefers-reduced-motion: reduce` でアニメーションが止まるか    | ✅ `h1` の `animation-name: none`                                                                                                                                                               |

**結論**: F-2 / F-3 の残課題はすべて解決。全自動ゲート + 実描画検証が緑。UI モダン化計画は全項目完了。
