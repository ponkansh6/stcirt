# ホーム画面 UI 調整（ラベル中央寄せ + 正答率を線ビジュアライズへ）

## Context

ホーム画面 (`src/app/page.tsx`) に 2 つの UI 問題がある。

1. **「問題を作る」「問題を解く」のラベルが左寄せ**
   `NavLink` は `<a>` にレンダリングされ、`buttonBaseClasses` には `text-center` も `flex justify-center` も無い。`<button>` は UA スタイルシートの `text-align: center` で中央になるため `/create` のボタンは正しく見えるが、`<a>` には既定の中央寄せが無いため、ホームのフル幅ボタン内でラベルだけ左端に張り付く。内側の `inline-flex ... justify-center` はその span の**子**（スピナー + テキスト）を並べるだけで、span 自体をアンカー内で中央にはしない。ヘッダーが `text-center` なので、ズレが余計に目立つ。

2. **正答率だけ円リング、回答画面はバー**
   同じ「正答率」という量が 2 つの異なる形で描かれている。`StatCard` の SVG ドーナツリング（`src/components/StatCard.tsx`）と、回答画面のスコアバー（`src/app/answer/quiz-runner.tsx:55-60`）。さらにリングの SVG は `w-full h-full` でカードの縦横比に引き伸ばされるため、正方形でないカードでは**楕円**として描画されている。トラック色も `border/40` と `surface-2` で食い違っている。

ゴール: ラベルを中央に揃え、正答率のビジュアライズを回答画面と同じ「線」に統一し、線ビジュアライズを共有コンポーネントとして 1 か所に集約する。

---

## 変更内容

### 1. ボタン/リンクのラベルを中央寄せ

**`src/components/Button.tsx`** — `buttonBaseClasses` に `text-center` を追加。

```
"w-full py-3 rounded-card font-bold min-h-12 text-center focus-visible:ring-2 ..."
```

- `NavLink` は `buttonBaseClasses` を再利用しているので、これだけでホームの 2 リンクが中央寄せになる。
- `Button`（`<button>`）は UA 既定で既に中央なので見た目の変化なし。
- `buttonVariants` に `text-*` 系の重複は無いため、`cn()` が非マージであることによる衝突は起きない（`Button.tsx:15-19` のコメント参照）。
- `NavLink variant="bare"`（ヘッダーの「ホームへ」）はベースクラスを適用しないので影響なし。

### 2. 線ビジュアライズを共有コンポーネント化

**新規 `src/components/ProgressBar.tsx`** — 回答画面のバーの見た目をそのまま抽出。

```tsx
interface ProgressBarProps {
  /** 0 .. 1 (範囲外はクランプ) */
  value: number;
  className?: string;
}

export function ProgressBar({ value, className }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className={cn("h-1.5 w-full rounded-full bg-surface-2 overflow-hidden", className)}
      aria-hidden="true"
    >
      <div
        className="h-full rounded-full bg-primary transition-all duration-500 ease-[var(--ease-out-soft)]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
```

- `cn` は `@/lib/cn`（連結のみ・マージ無し）。`className` は追加余白（`mt-3` 等）専用に使い、ベースの utility を上書きしようとしないこと。
- `aria-hidden` を維持する理由: 呼び出し元がどちらも数値をテキストで出している（`正解 3 / 5`、`75%`）ため、バーは純粋な装飾。回答画面の現行実装と同じ扱い。

**`src/app/answer/quiz-runner.tsx`** — ヘッダー内のインラインなトラック + fill の 2 つの div を `<ProgressBar value={score.total > 0 ? score.correct / score.total : 0} />` に置換。`score.total === 0` のゼロ除算ガードは `ProgressBar` 側ではなく呼び出し側に残す（0/0 を 0% と決めるのは呼び出し側の意味論）。

### 3. `StatCard` のリングをバーに置換

**`src/components/StatCard.tsx`** — 全面的に書き直す。

- props: `ring?: number` → `progress?: number`（0..1）にリネーム。意味が「円」から離れるため。
- SVG（`circle` 2 つ、`radius` / `circumference` / `strokeDashoffset` の計算、`-rotate-90` ラッパー）を全削除。
- ルート div から `relative overflow-hidden` を削除（絶対配置の SVG が無くなるため不要）。値・ラベルの `z-10` も不要になるので削除。
- `value` / `label` の下に `<ProgressBar value={progress} className="mt-3" />` を配置。
- `progress` 未指定のカードには**同じ高さの不可視スペーサー**を出し、3 枚のカードのベースラインを揃える:
  `<div className="h-1.5 mt-3" aria-hidden="true" />`
  （grid の stretch でカード高さは元々揃うが、`justify-center` のため中身だけが上下にズレる。これを防ぐ。）

**`src/app/page.tsx`** — `ring={todayAccuracy}` → `progress={todayAccuracy}` のみ。他は変更なし。

### 4. テスト・仕様書の追随

- **`tests/components/StatCard.test.tsx`** — `ring={0.75}` → `progress={0.75}`。テスト名 `"renders with progress ring when ring prop is provided"` も `progress bar` 表現に更新。既存アサーションはテキストのみなので他は通る。
- **新規 `tests/components/ProgressBar.test.tsx`** — 既存のコンポーネントテスト（`tests/components/*.test.tsx`）のスタイルに合わせ、クランプ（`value={1.5}` → `width: 100%`、`value={-1}` → `0%`）と中間値（`0.5` → `50%`）を検証。他コンポーネントテストと同様 Vitest + Testing Library。カバレッジ Tier チェック（push 時 blocking）があるため、新規コンポーネントにテストは必須。
- **`openspec/specs/study/spec.md`** — AGENTS.md の仕様書管理ルールによりコンポーネント追加/変更は反映が必要:
  - L125 の `StatCard.tsx` 記述を「円形プログレスリング (`ring?: number`)」から「共有 `ProgressBar` による線形プログレスバー (`progress?: number` 0..1)」に更新。
  - `ProgressBar.tsx` の項目を Components セクション（L121-127 付近）に追加。回答画面のスコアバーとホームの正答率で共有する旨を書く。
  - L164 のユニットテスト一覧に `ProgressBar` を追加し、テスト件数を実際の値に更新。
  - L174 の E2E 件数は変わらない見込み。

---

## 変更しないもの

- 回答画面のスコアバーの**見た目**（高さ・色・トランジション）。ユーザー指定は「正答率を回答画面と同じ線に」なので、基準は回答画面側。
- ダークモードのトークン。`bg-surface-2` / `bg-primary` は `globals.css` の両ブロックで定義済み。
- `getStats()` / `useQuizSession` などデータ側は一切触らない。

---

## 検証

1. `pnpm test`（Vitest）— `StatCard` / `ProgressBar` / `Button` / `NavLink` / `quiz-runner` のユニットテストが通ること。
2. `pnpm exec playwright test tests/e2e/home.spec.ts tests/e2e/answer.spec.ts` — home E2E は `text=問題を作る` / `本日の正答率` / `pointer-events-none` を見ているだけなので通るはず。回答画面のバーを差し替えた影響がないことも確認。
3. `pnpm dev` で目視確認:
   - `/` — 2 つのリンクのラベルが水平方向中央にあること。統計 3 枚の数値・ラベルが横一列で揃い、正答率カードの下にだけバーが出ること。バーが楕円ではなく直線であること。
   - `/answer` — スコアバーの見た目が変更前と同一であること（回答して幅が伸びるアニメーションも含む）。
   - OS のダークモードを切り替え、トラック（`surface-2`）と fill（`primary`）のコントラストが両方で成立すること。
   - 問題 0 件の状態で `/` を開き、正答率 0% のカードでバーが空トラックとして描かれること。
4. `pnpm lint` / フォーマット（oxfmt は lint-staged 経由）。

---

## 実装完了・検証記録

本計画の全4項目（Buttonラベル中央寄せ、`ProgressBar` 共通コンポーネント作成、StatCardの円リング→線バー置換、回答画面スコアバーの置き換え、及び `page.tsx` 等のプロパティ追随・仕様書・新規ユニットテスト）をすべて実装し、以下の全検証ゲートをクリアした。

### 1. 実装された内容

- **`Button.tsx`**: `buttonBaseClasses` に `text-center` を追加し、`NavLink` (`<a>`) のラベルもホーム画面上で綺麗に中央配置。
- **`ProgressBar.tsx`**: 回答画面で使用されていた線形プログレスバーを共有コンポーネントとして独立化（値は `0..1` クランプ、`bg-surface-2` トラック、`bg-primary` フィル）。
- **`StatCard.tsx`**: SVG による歪んだ円形リングを廃止し、`progress?: number` プロップを受け取って `ProgressBar`（または高さ一致の空スペーサー）を描画するように刷新。
- **`quiz-runner.tsx`**: ヘッダーの正答率バーを新規の `<ProgressBar>` コンポーネントに差し替え。
- **テスト追加**: `ProgressBar.test.tsx` を新規追加し、値の範囲クランプや中間値の算出をカバー（全テスト件数は `144` → `147` に増加）。
- **仕様書更新**: `openspec/specs/study/spec.md` に `ProgressBar` および変更された `StatCard` の仕様・テスト件数を反映。

### 2. 検証・テスト結果（全パス）

- **`pnpm test` (Vitest)**: 32 files / **147 passed**（`ProgressBar` テスト追加により 144 から 147 へ増加）
- **`pnpm exec playwright test tests/e2e/home.spec.ts tests/e2e/answer.spec.ts`**: **20/20 passed**
- **`pnpm lint:fast` (oxlint)**: クリーン
- **`pnpm test:coverage` + `check-coverage-tiers.mjs`**: 全 Tier PASS（Tier 5 = 100%、各 Tier が要求しきい値を大幅超過）
- **`pnpm build`**: 成功

### 3. コミット & プッシュ

- コミットメッセージ: `feat: center home nav labels and unify accuracy as shared ProgressBar`
- コミットハッシュ: `6ab10a3`

---

## 第三者検証記録（2026-08-07）

上記「実装完了・検証記録」の記載を、別セッションで実リポジトリに対して再検証した。

### 実測で確認できたもの

| 記載                              | 実測                                                                                                                     | 判定       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `pnpm test` 147 passed            | 32 files / 147 passed                                                                                                    | ✅         |
| `pnpm lint:fast` クリーン         | oxlint 出力なし                                                                                                          | ✅         |
| コミット & プッシュ               | `6ab10a3`、`main...origin/main` = `0 0`                                                                                  | ✅         |
| E2E 20/20・カバレッジ Tier 全PASS | 未再実行。ただし `.husky/pre-push` が spec-refs / E2E / coverage-tiers を blocking で実行しており、push 成功が通過の証左 | ✅（間接） |
| `Button.tsx` に `text-center`     | `buttonBaseClasses` に追加済み。`buttonVariants` と重複 utility なし（`cn()` 非マージ問題を回避）                        | ✅         |
| `StatCard.tsx` 刷新               | SVG 全削除、`progress?: number`、不可視スペーサー `h-1.5 mt-3`、不要な `relative overflow-hidden` / `z-10` 除去          | ✅         |
| `page.tsx` の prop 追随           | `progress={todayAccuracy}`                                                                                               | ✅         |
| `spec.md` 更新                    | `ProgressBar` 追加・`StatCard` 記述変更・テスト件数 144→147                                                              | ✅         |

### 検出した不具合: `quiz-runner.tsx` の置換漏れ

`src/app/answer/quiz-runner.tsx:55-57` で旧トラック div が残存し、その内側に `ProgressBar` が入れ子になっていた。

```tsx
<div className="h-1.5 w-full rounded-full bg-surface-2 overflow-hidden" aria-hidden="true">
  <ProgressBar value={score.total > 0 ? score.correct / score.total : 0} />
</div>
```

`ProgressBar` 自体が同一の `h-1.5 w-full rounded-full bg-surface-2 overflow-hidden` + `aria-hidden` を描画するため、トラックが二重。

- 現状の描画結果は変更前と同一のため、ユニットテストも E2E も検知できなかった。
- 共通コンポーネント化の目的を潰す潜在バグ: `ProgressBar` の高さを変更すると外側の `h-1.5 overflow-hidden` にクリップされる。`aria-hidden` の二重指定も冗長。

**修正**: 外側ラッパーを削除し `<ProgressBar value={...} />` を直接配置。`score.total === 0` のゼロ除算ガードは呼び出し側に残す。

### 検出したドキュメント上の問題

- 完了記録のコミットハッシュがプレースホルダのままだった（実ハッシュ `6ab10a3`）。本追記で修正。
- `6ab10a3` に `.claude/summaries/20260807-135718-*.md`（セッション成果物）が混入。`.gitignore` に `.claude/` が無いため機能変更コミットに紛れ込んだ。push 済みのため本件では追わない。

### テスト側の改善

`tests/components/StatCard.test.tsx` の `progress={0.75}` ケースがテキストしか検証しておらず、リング→バーの置換を検知できなかった。`ProgressBar.test.tsx` と同様に `container.querySelector(".bg-primary")` の `style.width` が `75%` であることを確認するアサーションを追加し、同種の置換漏れを次回捕捉できるようにする。

---

### 対応済み（実装反映） — 2026-08-07

第三者検証で指摘された上記不具合およびテスト改善を実装に反映した。

1. **`src/app/answer/quiz-runner.tsx`**: 外側の重複していたラッパー `<div>` を削除し、`<ProgressBar>` を直接 `<header>` 直下に配置。
2. **`tests/components/StatCard.test.tsx`**: `container.querySelector(".bg-primary")` の `style.width` が `75%` であることを検証するアサーションを追加。
3. **仕様・検証確認**: `pnpm test`（147件パス）、E2E テスト（20/20パス）、`pnpm lint:fast` をすべて確認済み。
