# Plan 72 実装記録スナップショット

- 実施日: 2026-10-17
- 着手時HEAD: `cc8b113`（Plan 71 実装・検証記録コミット済み）
- owner決定スコープ: **P1+P2 全レーン、候補1は reset 操作のみ**
- 原典: `shared_plan/72-UIUX_TREND_IMPROVEMENT_PLAN.md`（gitignore 対象のため本書を証跡としてコミットする）

## 候補別 採否

| 候補                                                | 採否               | 内容 / 理由                                                                                                                                          |
| --------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 破壊操作の確認                                   | 採用（reset のみ） | `presentation-admin.tsx`「最初に戻る」を native `<dialog>` 確認化。`cancel`(Esc)/背景クリック= mutation なし、`実行`= `runAction("reset")` 1回のみ。 |
| 2. `field-sizing: content`                          | 採用               | 新規 `src/app/answer/quiz-runner.module.css`。`@supports` 内で textarea に宣言 + `min-height: 6lh`。                                                 |
| 3. `text-wrap: balance/pretty`                      | 採用               | results-panel, EmptyState, ErrorMessage。                                                                                                            |
| 4. `@starting-style`                                | 採用（入場のみ）   | `.banner-entry`（`@starting-style` + keyframe fallback、reduced-motion 無効）。退場遷移は不採用（未計測 + regression リスク）。                      |
| 5. `prefers-reduced-transparency/contrast`          | 採用（条件付き）   | `glass-header` media query。**視覚回帰の機械確認は未実施**。                                                                                         |
| 6. View Transition                                  | 保留               | Plan 71 の latest-wins 高頻度更新との相互作用、R8 fit/focus 非破壊前提が未検証・未計測。                                                             |
| 7. `useOptimistic`/`useFormStatus`                  | no-change          | 既存 `busyAction` + `role="status"` で充足。確認済み不足なし。                                                                                       |
| 8. `interpolate-size: allow-keywords`               | 採用               | `presentation-admin.module.css` に限定。                                                                                                             |
| 9. Popover / anchor positioning / Speculation Rules | 保留               | 必要性が生じた場合のみ。                                                                                                                             |

## 検証ゲート（Orchestrator 実行）

| ゲート                 | 結果                                                                           |
| ---------------------- | ------------------------------------------------------------------------------ |
| `pnpm lint:fast`       | exit 0（既存 warning のみ）                                                    |
| `pnpm format:check`    | exit 0                                                                         |
| `pnpm type-check:fast` | exit 0                                                                         |
| `pnpm test`            | 65 files / 1086 tests PASS                                                     |
| `pnpm test:coverage`   | Plan 72 新規コードは閾値達成。残 ERROR は Plan 71 由来 deferred 2 ファイルのみ |

### coverage 詳細

- `src/app/admin/presentation/presentation-admin.tsx`: ERROR 解消。
  - 外部 close イベント中の `onClose` 分岐を追加テスト（`re-syncs dialog state when an external close event arrives while the confirmation is pending`）で消化。
  - 通常フロー到達不能な防御ガード3箇所を既存慣例の `/* v8 ignore if|else */` で明示:
    - `presentation-admin.tsx` の `if (!dialog.open) dialog.showModal();`（else 側）
    - `if (dialog.open) dialog.close();`（else 側）
    - `onClick` 内 `if (!dialog) return;`（if 側）
- 残 ERROR（本書スコープ外 / 別タスク・71 側に記録済み）:
  - `src/app/presentation/presentation-screen.tsx`（lines 97.31 / funcs 98.92 / stmts 96.47 / branch 96.34、未到達 1057,1061,1068,1232）
  - `src/lib/db/repository/presentation-repository.mutations.ts`（stmts 99.7 / branch 99.66、未到達 575）

## 未計測の明示

改善率・WCAG 適合・field 性能・利用者効果の数値主張は行わない（Plan 69 claim gate 準拠）。候補5は視覚回帰の機械確認が未了。

## 変更ファイル（Plan 72）

```
 src/app/GlobalHeader.tsx                           |   2 +-
 src/app/admin/presentation/presentation-admin.module.css |   6 +
 src/app/admin/presentation/presentation-admin.tsx  |  65 ++++++++-
 src/app/answer/quiz-runner.tsx                     |   3 +-
 src/app/answer/quiz-runner.module.css              | (新規 / untracked)
 src/app/globals.css                                |  34 +++++
 src/app/results/results-panel.tsx                  |  47 ++++---
 src/components/EmptyState.tsx                      |   4 +-
 src/components/ErrorMessage.tsx                    |   2 +-
 src/components/ResultBanner.tsx                    |   2 +-
 tests/answer/quiz-runner.test.tsx                  |   2 +
 tests/app/admin/presentation-admin.test.tsx        | 151 ++++++++++++++++++++-
 tests/components/ResultBanner.test.tsx             |   1 +
```

## テスト実装の補足

- `tests/app/admin/presentation-admin.test.tsx`: jsdom に `HTMLDialogElement.prototype.showModal/close` が無いため `beforeAll` で stub（`close()` は native 挙動に合わせ `close` イベントを dispatch）。確認フローに伴い既存 reset テストへ「実行」クリックを追加。追加テスト: 確認ダイアログの open/cancel/背景クリック/外部 close 同期/再open→実行1回。

## 残タスク

- Plan 71 deferred coverage（上記2ファイル）の解消 — 別タスク。
- 本 Plan 72 変更のコミット判断（owner）。
