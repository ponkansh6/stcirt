# ボタン押下時の視覚フィードバック統一（Button.tsx への水平展開）

## Context

`/answer` の選択肢ボタン（`ChoiceButton.tsx`, コミット `b6504e9`）では、タップ直後にスピナー・他選択肢の無効化・押し込みアニメーション（`motion-safe:active:scale-[0.98]`）を追加し、「押せたかどうか」が分かるようにした（`shared_plan/SELECTION_FEEDBACK_PLAN.md` で実装内容を検証済み）。

同じ問題が他のボタン・リンクにも存在する（コードベース調査により確認）:

- `src/components/Button.tsx`（共通ボタンコンポーネント）に `active:*` の押し込みスタイルも `loading` prop も存在せず、これを使う全ボタンが `hover:*` のみに依存している。モバイルのタップでは `hover` が発火しないため、実質フィードバックがない
- `src/app/layout.tsx`（22-24行目、「ホームへ」Link、全ページ共通ヘッダー）や `src/app/page.tsx`（17-32行目、トップページの2つのCTA Link）は `Button` すら経由せず `<Link>` に直接 Tailwind クラスを書いており、`hover:*` のみ
- `src/app/create/page.tsx` の「ホームへ」「問題を解きに行く」（79-82行目、`router.push`）、`src/app/answer/quiz-runner.tsx` の「次の問題へ」（95行目）「再試行」（`ErrorMessage.tsx` 経由、非同期 `loadNext`）もボタン単位のフィードバックがない
- 「この内容から1問作る」（`create/page.tsx` 51行目）と「次の問題へ」「再試行」は非同期処理だが、現状は画面全体を `LoadingState` にまるごとスワップする荒い体験で、ChoiceButton のような「ボタン単位の反応」とはUXの一貫性がない
- `src/app/globals.css` にも共通の press アニメーション定義はなく、ChoiceButton への追加は他のコンポーネントに一切継承されていない

Next.js は `^16.2.9`、React は `^19.2.7` のため、Link のナビゲーション中状態を扱う `useLinkStatus()`（App Router 標準フック）や `useTransition` が利用可能。

**ゴール**: ChoiceButton で確立したパターン（押し込みアニメーション・ローディング表示・disabled制御）を共通 `Button` コンポーネントと主要な `Link` に水平展開し、アプリ全体でタップ即座の反応を一貫させる。

**スコープ外**: `QuestionCard.tsx` の未使用インタラクティブ経路（`onSelect` は現状どこからも呼ばれていない、表示専用として利用中）。

---

## 方針決定

| 項目                             | 決定                                                                                                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 押し込みアニメーション           | 全ボタン共通で `motion-safe:active:scale-[0.98]` を `Button.tsx` のベースクラスに追加（ChoiceButton と同じ値で統一）                                                                                                                                     |
| 非同期ボタンのローディング表示   | `Button.tsx` に `loading?: boolean` prop を追加。true時: `disabled` 化・`aria-busy`・インラインスピナー（ChoiceButton と同じ `w-4 h-4 border-2 border-t-transparent rounded-full animate-spin` を流用、色は variant に合わせて `border-current` にする） |
| Link のナビゲーション中表示      | `useLinkStatus()`（Next.js App Router 標準）を使い、pending 中に `active:scale` 相当の視覚変化 or 軽いopacity低下を表示する小さなラッパーコンポーネントを用意                                                                                            |
| router.push ボタンのローディング | `useTransition` の `isPending` を `Button` の `loading` prop に渡す                                                                                                                                                                                      |
| 「次の問題へ」「再試行」         | 画面全体スワップ方式は維持しつつ、ボタン自体にも `loading` を渡し、連打時の二重発火を防ぐガードを `loadNext` に追加（実行中は早期return）                                                                                                                |

---

## 変更内容

### 1. `src/components/Button.tsx`

- ベース className に `motion-safe:active:scale-[0.98]` を追加
- `loading?: boolean` prop を追加。true 時: `disabled={true}`、`aria-busy={true}`、children の前にスピナー `span` を描画

### 2. `src/app/layout.tsx` — 「ホームへ」Link（22-24行目）

- `useLinkStatus()` を使う小さな `NavLink` ラッパー、または `<Link>` 配下で `useLinkStatus` を呼ぶ子コンポーネントに置き換え、pending 中に視覚変化を出す
- `active:scale-[0.98]` 相当のクラスを追加

### 3. `src/app/page.tsx` — トップページ2つのCTA Link（17-32行目）

- 同上のパターンを適用

### 4. `src/app/create/page.tsx`

- 「この内容から1問作る」（51行目）: 既存の `loading` state を `Button` の `loading` prop に接続（全体スワップと併用可）
- 「問題を解きに行く」「ホームへ」（79-82行目）: `useTransition` + `router.push` に変更し、`isPending` を `Button` の `loading` prop に渡す

### 5. `src/app/answer/quiz-runner.tsx` / `src/components/ErrorMessage.tsx`

- 「次の問題へ」（95行目）「再試行」（`ErrorMessage.tsx` 14-16行目）ボタンに `loading` prop（適切な phase 状態）を接続
- `src/app/answer/use-quiz-session.ts` の `loadNext`（24-45行目）に多重発火防止のガードを追加（実行中フラグで早期return）

---

## テスト

- 単体: `Button.tsx` の `loading` prop（disabled化・aria-busy・スピナー描画）の挙動テスト
- 単体: `loadNext` の多重発火防止の回帰テスト（同時に2回呼んでも fetch が1回であること）
- e2e: 各ページで対象ボタン/リンクをクリックした際に `aria-busy` またはローディング表示が出ることを確認するケースを追加

---

## ドキュメント同期（AGENTS.md のルール）

- `openspec/specs/study/spec.md` — 該当するUI要件にボタン押下フィードバックの統一を追記
- `src/app/codemap.md` — `Button.tsx` の `loading` prop 追加を反映

---

## 実装順序

1. `Button.tsx` に `active:scale` と `loading` prop を追加（基盤）
2. `layout.tsx` / `page.tsx` の Link に `useLinkStatus()` ベースのフィードバックを追加
3. `create/page.tsx` の各ボタンを `loading` / `useTransition` に接続
4. `quiz-runner.tsx` / `ErrorMessage.tsx` のボタンに `loading` を接続、`loadNext` に多重発火ガードを追加
5. 単体テスト・e2eテスト追加
6. 仕様書・codemap の同期

AGENTS.md の制約に従い、subagent の同時実行は最大3まで。`--no-verify` / `HUSKY=0` は使用しない。

---

## 検証

```bash
pnpm type-check
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
```

手動確認（`pnpm dev`、モバイル幅・DevTools Network throttling で実施）:

1. 「ホームへ」「問題を作る」「問題を解く」をタップ → 指を離す前にボタン/リンクが少し反応する
2. 「この内容から1問作る」タップ直後、ボタンにスピナーが出て連打しても再送信されない
3. 「次の問題へ」「再試行」を連打しても `/api/questions/random` が1回しか発火しない
4. OS の「視差効果を減らす」を有効にすると、押し込みアニメーションが無効になる

---

## 進捗

- [100%] 本計画に基づき、共通 `Button` への `motion-safe:active:scale-[0.98]` と `loading` prop・インラインスピナーの追加、`NavLink` (`useLinkStatus`) の新規作成とヘッダー・トップページへの適用、`create/page.tsx` における `useTransition` / `loading` 接続、`useQuizSession` / `loadNext` の多重発火防止ガード追加、`quiz-runner.tsx` / `ErrorMessage.tsx` への `loading` 接続を実施。さらに単体テスト・E2Eテストを追加し、仕様書・codemapの同期を完了した。
