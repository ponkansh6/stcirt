# 回答選択時の即時フィードバック改善（送信中の状態表示）

## Context

`/answer` で選択肢をタップしてから正誤が出るまで、`POST /api/answers` の往復ぶんのラグがある。
その間 **画面が一切変化しない** ため、ユーザーは自分のタップが通ったのか判断できない。

`src/app/answer/use-quiz-session.ts:46-74` の `select()` は、`await submitAnswer(...)` が
解決するまで `setPhase` を一切呼ばない。したがって待機中も `phase.kind` は `"question"` のままで、
`quiz-runner.tsx` は `isGraded = false` として全選択肢を `variant="idle"` で描画し続ける。

さらに、この構造は **二重送信バグ** も生んでいる:

```ts
const select = useCallback(async (shuffledIdx: number) => {
  if (phase.kind !== "question") return;   // ← 待機中も "question" のままなのでガードが効かない
  ...
  const result = await submitAnswer(quiz.question.id, originalIdx);
```

`ChoiceButton.tsx:35` の `disabled={disabled || variant !== "idle"}` も、待機中は
`disabled=false` / `variant="idle"` なので **ボタンは押せたまま**。
反応が無いユーザーは連打しがちで、その結果:

- `answer_logs` に同じ問題の行が複数記録され、統計（正答率）が歪む
- `setScore` が複数回走り `total` が余分に増える
- `setPhase({kind:"graded"})` が複数回走り、**最後に返ってきたレスポンスが勝つ** ため、
  最初にタップした選択肢とは違う選択肢がハイライトされうる

つまり今回の要望は UX 改善であると同時に、実データを壊すバグの修正でもある。

**ゴール**: タップした瞬間に「押せた」ことが分かり、採点待ちであることも伝わる。
併せて待機中の二重送信を構造的に不可能にする。

**スコープ外**: ラグそのものの短縮。採点をサーバー側で行うのは
`openspec/specs/study/spec.md` R3 の要件（出題レスポンスに正解を含めないことでカンニングを防ぐ）
であり、往復を無くすことはできない。体感の改善で対応する。

---

## 方針決定（ユーザー確認済み）

| 項目             | 決定                                                             |
| ---------------- | ---------------------------------------------------------------- |
| 採点待ちの見せ方 | **選択色 + ボタン内スピナー**。他の選択肢は減光して無効化        |
| 押した瞬間の反応 | **押し込みアニメーション**（`active:scale`、CSS のみでラグゼロ） |
| バイブレーション | 入れない                                                         |

---

## 変更内容

### 1. `src/app/answer/use-quiz-session.ts` — `submitting` フェーズの追加

`Phase` union に 1 つ追加する。

```ts
export type Phase =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "question"; quiz: LoadedQuiz }
  | { kind: "submitting"; quiz: LoadedQuiz; selectedIndex: number } // ← 追加
  | { kind: "graded"; quiz: LoadedQuiz; selectedIndex: number; result: AnswerResult };
```

`select()` は **`await` の前に** `submitting` へ遷移させる。

```ts
if (phase.kind !== "question") return;
const { quiz } = phase;
setPhase({ kind: "submitting", quiz, selectedIndex: shuffledIdx });   // ← 即座に反映
const originalIdx = quiz.shuffled.choiceIndices[shuffledIdx];
try {
  const result = await submitAnswer(quiz.question.id, originalIdx);
  ...
```

これだけで既存の `if (phase.kind !== "question") return;` ガードが実際に機能し、
待機中の 2 回目のタップは早期 return される（＝ 二重送信バグが構造的に解消する）。
`mountedRef` ガードとエラー時の `phase → error` 遷移は現状どおり維持する。

### 2. `src/components/ChoiceButton.tsx` — `selected` variant と押し込み

- `ChoiceVariant` に `"selected"` を追加。スタイルは `border-primary bg-primary/10`。
  文字色は上書きしない（`correct` / `selectedWrong` は `text-success` / `text-error` を
  当てているが、`primary` を本文に当てるとコントラストが落ちるため）。
- `variant === "selected"` のとき、`✓` / `✗` と同じ `ml-auto` の位置にスピナーを出す。
  マークアップは `src/components/LoadingState.tsx:8` の
  `border-primary border-t-transparent rounded-full animate-spin` を流用し、
  `w-4 h-4 border-2` に縮小する。
- `aria-busy={variant === "selected"}` を付与。
- 押し込みアニメーションを className に追加:
  `motion-safe:active:scale-[0.98]`。`motion-safe:` を付けて
  `prefers-reduced-motion` を尊重する（仕様 R6 の WCAG 2.1 AA 要件）。
- **`disabled` の導出を整理**: 現在の `disabled={disabled || variant !== "idle"}` は、
  待機中に「選択されていない他のボタン」が `variant="idle"` のままなので無効化できない。
  暗黙の導出をやめて `disabled={disabled}` にし、呼び出し側が明示的に渡す形にする。

### 3. `src/app/answer/quiz-runner.tsx` — 3 状態の描画分岐

`submitting` は `loading` の早期 return には入れない（問題文を出したまま待たせる）。
既存の early return 群（`loading` / `empty` / `error`）はそのまま。

```ts
const isPending = phase.kind === "submitting";
const isGraded = phase.kind === "graded";
const selectedIndex = isPending || isGraded ? phase.selectedIndex : undefined;
const result = isGraded ? phase.result : undefined;
```

variant の決定:

| 状態         | 選んだ選択肢                                  | それ以外                                     |
| ------------ | --------------------------------------------- | -------------------------------------------- |
| `question`   | —                                             | `idle`                                       |
| `submitting` | `selected`（スピナー）                        | `muted`（減光）                              |
| `graded`     | 正解なら `correct` / 誤答なら `selectedWrong` | 正解は `correct`、他は `muted`（現行どおり） |

`ChoiceButton` へは `disabled={isPending || isGraded}` を明示的に渡す。
sticky「次の問題へ」の表示条件は `isGraded` のまま（待機中は出さない）。

---

## テスト

### 単体 — `tests/answer/use-quiz-session.test.tsx`（既存に追加）

既存の `vi.stubGlobal("fetch", ...)` パターンをそのまま使う。

- `/api/answers` のモックを **すぐには解決しない Promise** にして、`select()` 実行直後に
  `phase.kind === "submitting"` かつ `phase.selectedIndex` が押した index であることを検証
- **二重送信の回帰テスト**: 待機中に `select()` をもう一度呼び、
  `/api/answers` への fetch 呼び出しが 1 回だけであること、
  解決後の `score.total` が 1 であることを検証

### e2e — `tests/e2e/answer.spec.ts`（既存に追加）

既存テストと同じ `page.route(...)` モック方式。`/api/answers` のハンドラ内で
`await new Promise((r) => setTimeout(r, 500))` を挟んでラグを再現する。

- 選択直後、押したボタンが `aria-busy="true"` を持つこと
- 他の選択肢が `disabled` であること
- 問題文が消えずに表示されたままであること
- 500ms 後に `graded`（正解！ バナー）へ遷移すること

---

## ドキュメント同期（AGENTS.md のルール）

- `openspec/specs/study/spec.md`
  - **R3** に「選択直後、採点結果が返るまで選択した選択肢を送信中として表示し、
    その間の再送信を受け付けない」を追記
  - **Components → /answer** の `use-quiz-session.ts` の説明に `submitting` フェーズを追記
- `src/app/codemap.md` — `use-quiz-session.ts` の行に送信中状態の記述を追加

---

## 実装順序

1. `use-quiz-session.ts` に `submitting` フェーズを追加（バグ修正の本体）
2. `ChoiceButton.tsx` に `selected` variant・スピナー・押し込み・`disabled` 整理
3. `quiz-runner.tsx` の描画分岐を 3 状態に対応
4. 単体テスト追加（`submitting` 遷移 + 二重送信ガードの回帰テスト）
5. e2e テスト追加（遅延モックで送信中表示を検証）
6. 仕様書・codemap の同期

AGENTS.md の制約に従い、subagent の同時実行は最大 3 まで。
`--no-verify` / `HUSKY=0` は使用しない。

---

## 検証

```bash
pnpm type-check      # Phase union に submitting を足した影響が全て潰れているか
pnpm lint
pnpm test            # 単体（新規の submitting 遷移 + 二重送信ガード）
pnpm test:e2e        # Playwright（chromium + Mobile Chrome）
pnpm build
```

手動確認（`pnpm dev`、DevTools の Network で Slow 3G などにスロットリングして実施）:

1. `/answer` で選択肢をタップ → **指を離す前にボタンが少し沈む**
2. タップ直後、そのボタンが primary 色になりスピナーが回る。他の選択肢は減光して押せない
3. 問題文はそのまま表示され続ける（ローディング画面に切り替わらない）
4. 待機中に他の選択肢や同じ選択肢を連打しても、Network タブの `/api/answers` が
   **1 回しか発火しない**
5. レスポンス到着後、「正解！」/「不正解」バナーと ✓ / ✗ が出る。
   ヘッダーのスコアが **1 だけ** 増える（連打しても 2 増えない）
6. OS の「視差効果を減らす / アニメーションを減らす」を有効にすると、
   押し込みアニメーションが無効になる

---

## 進捗

**完了日**: 2026-08-05
**コミット**: `b6504e9` — fix: add submitting phase to prevent double-submission and show loading feedback

### 実装フェーズ

| #    | フェーズ                                                                        | 担当   | 状態    | 検証                                             |
| ---- | ------------------------------------------------------------------------------- | ------ | ------- | ------------------------------------------------ |
| 1    | submitting フェーズ追加 + ChoiceButton selected variant + quiz-runner 3状態対応 | @fixer | ✅ 完了 | type-check/lint/test exit0                       |
| 2    | 単体テスト (submitting遷移 + 二重送信ガード) + e2eテスト                        | @fixer | ✅ 完了 | test 21/21 / e2e 22/22                           |
| 3    | ドキュメント同期 (spec.md R3 + codemap)                                         | @fixer | ✅ 完了 | type-check/lint exit0                            |
| 最終 | 最終検証                                                                        | -      | ✅ 完了 | type-check/lint/test 21/21/e2e 22/22/build exit0 |

### 変更ファイル一覧

**変更:**

- `src/app/answer/use-quiz-session.ts` — Phase union に `submitting` 追加、`select()` で await 前に即遷移
- `src/components/ChoiceButton.tsx` — `selected` variant 追加、スピナー、`aria-busy`、`motion-safe:active:scale-[0.98]`、`disabled` を呼び出し側明示に
- `src/app/answer/quiz-runner.tsx` — `isPending`/`isGraded` の 3 状態描画分岐、`disabled={isPending || isGraded}` を ChoiceButton に明示渡し
- `openspec/specs/study/spec.md` — R3 に送信中状態・二重送信防止の記述追加、Components → /answer に submitting フェーズ追記
- `src/app/codemap.md` — use-quiz-session.ts に送信中状態の記述追加
- `tests/answer/use-quiz-session.test.tsx` — submitting 遷移テスト + 二重送信ガード回帰テスト追加
- `tests/e2e/answer.spec.ts` — Test D: aria-busy + disabled + 遅延モックで送信中表示検証

### 検証結果

```bash
pnpm type-check      # exit 0
pnpm lint            # exit 0
pnpm test            # 21/21 passed (shuffle, schemas, use-quiz-session, answers, questions)
pnpm test:e2e        # 22/22 passed (chromium + Mobile Chrome)
pnpm build           # exit 0
```
