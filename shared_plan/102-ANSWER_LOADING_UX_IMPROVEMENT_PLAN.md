# 回答体験の読み込み待ち UX 改善計画

## 状態

- 作成日: 2026-10-30
- 最新技術調査日: 2026-10-30（React、Next.js、Web Vitals、ブラウザーAPIの公式資料を確認）
- 状態: P0/P1/P1bの実装、仕様同期、回帰テスト、production webpack buildを完了。P1のPOST長待ち文言は通信分布の計測根拠がないため延期し、P2も遅延源の実測がないため未提案。production route probeはローカル合成シナリオで実施済みだが、実通信分布、INP/Event Timing、回答画面CLS、実BFCache、スクリーンリーダーを含む手動ブラウザー検証は未完了。したがって実装・自動検証ゲートは完了、全受け入れ条件は未完了。
- 保存場所: `shared_plan/102-ANSWER_LOADING_UX_IMPROVEMENT_PLAN.md`
- 対象: 回答開始から送信、完了、結果表示まで。回答者向け画面を優先し、管理画面は対象外。
- ユーザーの追加回答がないため、対象範囲は上記と仮定した。
- 実装後のlockfile解決版: Next.js `16.4.2`、React/React DOM `19.3.0`、`@types/react` / `@types/react-dom` `19.3.0`、`motion` `14.2.0`。`reactCompiler: true`。`cacheComponents`、Partial Prefetching、View Transition用の設定はない。React/React DOM 19.3系への更新はユーザー許容済み。ViewTransition導入は本計画の正式な実施項目。spinner、reduced-motion対応、Button loadingは既存共通UIを利用できる。

### 実装・検証記録 (2026-10-31)

| 項目 | 状態 |
| --- | --- |
| P0 unknown recovery / 保存確定表示 | 実装済み。保存の完全な復元・整合性確認を成功根拠とし、manual GET retry、scope/generation stale guard、cleanupを含む。 |
| P1 初期 skeleton と pending表示 | 実装済み。POST長待ち補足文言は通信分布の実測待ちのため延期。 |
| P1b React/DOM 19.3.0 と限定ViewTransition pilot | 実装済み。React Compilerは有効のまま。実機互換性・hydration確認は未検証。 |
| Unit/component + coverage | PASS: 1,290 tests / 75 files、coverage 100%。 |
| Build後の型エラー修正確認 | PASS: lifecycle test 6/6 tests。callback captureの型エラーを修正後に実行。 |
| Typecheck / lockfile sync / format / oxlint / security / spec refs | PASS。 |
| E2E | PASS: 13 tests。 |
| Production webpack build | PASS: 昇格実行でGoogle Geist取得、webpack compile、TypeScript、19 static pages生成、optimization/build tracesまで完了。初回buildで検出したlifecycle testのTS2349を修正し、再実行で成功。 |
| Route-level performance measurement | PARTIAL: `node scripts/measure-client-routes.mjs` PASS。Chromium headless 1365x768、ローカル合成fixtureで3 samples/route。合成回答flowはlogin→first question 133.1ms、submit→completion 83.8ms。POST/GET handlerの計測値も即時mock由来で、通信/DB latencyの代表値ではない。throttled/delayed/failing network、answer CLS、INP/Event Timing、POST/GET分布、background/BFCacheは未測定。 |
| Browser/manual accessibility and motion verification | PARTIAL: answer E2Eではreduced-motion設定およびaxeの自動確認を実施済み。実スクリーンリーダー、実BFCache restore、production browser上のViewTransition/hydration/React Compiler/motion共存、manual fallback/focus確認は未検証。 |
| Overall acceptance / P2 | 実装と自動検証ゲートは完了。実通信計測・manual browser checksを含む全受け入れ条件は未完了のため、全体完了とはしない。POST長待ち文言およびP2は遅延源・必要性の測定根拠がないため未提案。 |

## 目的と成功条件

回答者が待ち時間中に「何を待っているか」「回答が保存されたか」「次に何をできるか」を理解できるようにする。読み込み表示を増やすこと自体ではなく、実際の処理状態を正しく伝え、誤った成功表示・不要な再送・待ち続けるだけの画面を防ぐ。

成功条件:

1. 実際の処理が続いている間は、その処理を短い文言で伝え、完了後にspinnerを残さない。
2. 回答保存の確認と結果公開状況の確認を分ける。公開状態が未確定の間、結果閲覧・修整などを利用可能と誤認させない。
3. 確認通信の失敗後に状態を「非公開」や「結果なし」と推測せず、待ち続けるだけにもしない。回答者が明示的に再確認できる。
4. 回答内容、二重送信防止、既存の同じoperation ID/payloadでの再試行、再認証、owner/assisted scopeの保護を維持する。
5. keyboard操作、スクリーンリーダー、reduced motionに対応し、待ち表示の追加による大きなレイアウト移動を抑える。
6. 主観的な「高速化」や性能目標を根拠なく主張しない。改善前後は個人情報や回答payloadを記録せずに計測する。

## 現状と既存計画との境界

- `src/app/answer/use-quiz-session.ts:30-45` に`loading` / `submitting` / `complete` phaseがある。batch POST成功後にcompleteへ遷移する (`:1110-1138`)。送信中は選択済み回答を保ち、同期二重送信ガードと操作ロックがある。
- `src/app/answer/quiz-runner.tsx:256-264` は送信中表示と変更・再送のロックを表示する。loading面 (`:666-673`) は中央の文言が中心で、骨格表示はない。`ResultLinkPending` (`:29-48`) はNext Link配下の`useLinkStatus()`で固定サイズspinnerとpolite通知を表示する。
- 公開状況確認中の完了面 (`src/app/answer/quiz-runner.tsx:713-721`) は「結果の公開状況を確認しています…」を表示する。`use-participant-results-visibility.ts:69-143` は参加者/scope単位で結果を保護し、initial lookupとvisibility復帰時のrefreshを行う。refreshはprivateで、現状abort controllerはない。
- `openspec/specs/stcirt/spec.md:560-567` は、公開状態の初期通信失敗・不正payloadでも`unknown` loading面を維持し、自動pollしない契約を定める。401時の再認証優先、確定結果の背景更新で前回値を保つこと、`/results`でroute-level loading shell/spinnerを出さないことも定める。
- 重要な保存判定上の注意: `complete` phaseだけでは保存確定とみなせない。通常POSTは返却ID照合・revision更新後にcompleteとなる (`use-quiz-session.ts:1128-1138`)、正常復元も保存済みsubmission取得後にcompleteとなる (`:645,667-697`)。一方、restoreError付き復元失敗 (`:645-680`)、返却ID不一致 (`:1122-1126`)、409後の不正保存復元 (`:1161-1189`)、明示refresh時の不正保存 (`:1240-1276`) もcompleteを通る。よって「回答は送信済みです」はphaseだけから導出せず、現在のparticipant/scope/対象回答に紐づく確定根拠がある経路に限定する。submissionIdの存在や過去の保存成功だけも十分な根拠ではない。
- `98-RESULT_NAVIGATION_LOADING_SPINNER_FIX_PLAN.md` は完了画面から結果ページへの遷移とSSR lookup待ちを扱い、`99-PUBLICATION_STATUS_COMPLETION_LOADING_PLAN.md` は未確定公開状態の表示を扱った。両方の認可・SSR・誤CTA防止の契約を再実装しない。本計画の差分は、通信lifecycleの見せ方、unknown後の手動回復、回答保存確認と公開確認の区別である。
- `101-WEB_UI_INTERACTION_IMPROVEMENT_PLAN.md` は作成時点のView Transitionの判断を記録した履歴として保持する。本計画では2026-10-30時点の公式状況とユーザーの依存更新許容を反映し、React/React DOM 19.3系への更新とViewTransition導入をP1bの実施工程に加える。

## 調査時点の技術判断

| 技術 | 公式資料で確認した状態 | このリポジトリへの判断 |
| --- | --- | --- |
| React `<ViewTransition>` | React 19.3でstable。Next.jsの現行App Routerガイドは設定なしの利用と、非対応ブラウザーで通常表示する挙動を説明する。[React 19.3](https://react.dev/blog/2026/09/09/react-19-3) | 作成時点ではReact/DOM `19.2.8`。実装でReactとReact DOMを同じ`19.3.0`へ更新し、限定pilotをP1bで導入済み。Nextガイドの16.4.3はドキュメント表示版で、Next 16.4.2との互換性を保証する最小版ではない。[Next.js View Transitions](https://nextjs.org/docs/app/guides/view-transitions) |
| React `startTransition` / `useTransition` | 更新の優先度とpendingを表す機能。サーバーとの保存契約や通信完了を保証しない。 | 送信受付と二重送信ガードは即時に保つ。将来の非緊急な画面更新に使う場合も、pendingを通信の事実として流用しない。 |
| React `useFormStatus` / `useOptimistic` | form Action内のpending参照、および処理中の仮表示に使える機能。 | 現在のclient fetch・保存復旧を移行する理由はない。仮表示APIを一律に禁じず、保存・公開成功を未確認のまま見せない条件を適用する。 |
| React `<Activity>` / `useEffectEvent` | React 19.2で追加された機能。[React 19.2](https://react.dev/blog/2025/10/01/react-19-2) | 画面を隠してstateを維持する用途やEffect内イベント用で、今回の読み込み表示を速める目的には直接当たらない。新規採用しない。 |
| Next.js Cache Components / Partial Prefetching | Cache Componentsはstable、Partial Prefetchingも導入済み。ただしPartial PrefetchingにはCache Componentsが必要で、ルートのprerender条件やSuspense境界に影響する。[Cache Components](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents) | 現在は無効。認証済みの動的な`/results`を含むため、本計画の必須変更にしない。遅延原因がSSRと確認できた時に独立評価する。 |
| Web Vitals INP / CLS | field INPの75パーセンタイル200ms以下は「良好」の参考基準。[web.dev: INP](https://web.dev/articles/inp) | ローカルの未計測SLOに転用しない。クリック後の最初の描画応答と通信の完了時間を別に測る。 |
| Abort API / browser timers | `AbortSignal.timeout()`はactive timeで期限を数え、documentがBFCache内にいる間などは停止する。通常の`setTimeout`もバックグラウンドで遅延し得る。 | 15秒は厳密なwall-clock保証ではなく、GET待ちのbest-effort budgetとする。復帰時にも保存deadlineを検査する。POSTには使わない。 |

React 19.3およびNext.jsガイドの確認日は2026-10-30。ガイド自体は2026-10-15更新を表示している。React/DOM更新は許容済みの作業範囲であり、Next.js 16.4.2との実互換性確認は通常の実装・検証工程として行う。特にNextのpeer dependency範囲だけを実行時互換性の証拠にしない。16.4.3表示を最低対応版とみなさず、公式互換情報と実測に基づいて必要な場合のみNextのpatchも同じ工程で更新する。

## UX方針と画面状態

| 場面 | 表示案 | 保つ契約 |
| --- | --- | --- |
| 回答開始・設問取得中 | 実際のカード寸法に近い非操作スケルトン、短い状態文。既存の設問load失敗retryを維持する。 | skeletonは回答や操作可能な選択肢に見せない。高速応答に人工的な最低表示時間を加えない。 |
| 回答送信中 | 選択内容を残し、現行の送信中ラベルと操作ロックを即時表示する。長待ち補足は通信分布の実測で必要性が確認されるまで追加しない。 | 成功/失敗を時間で推測せず、回答POSTを自動再送しない。 |
| POST確定後・公開確認pending | 保存確定が裏付けられる経路に限り、回答送信済みの短い案内と、結果公開状況を確認中の補助案内を分けて見せる。 | `complete` phaseのみを保存証拠にしない。復元エラー等の回復表示を成功案内で覆わない。未確定の結果CTAを出さない。 |
| 公開確認がunknownのまま通信終了 | 「公開状況を確認できませんでした」等の静的案内と「もう一度確認する」を表示する。再確認中だけボタンのpendingを示す。 | `unknown`を`waiting` / `unavailable`と扱わない。再確認はGETのみ。回答再送・修整・結果・代理開始CTAは出さない。401は既存の再認証を優先。 |
| 公開確認の正常なwaiting / unavailable | 現行specの該当表示を保つ。通信が終わった正常な判定にspinnerや進捗を付けない。 | 公開判定状態と通信状態を混同しない。自動pollは追加しない。 |
| 確定済み結果の背景refresh | 前回の確定表示を保ち、背景refresh中は視覚spinner・読み上げを追加しない。 | transient failureで確定結果を消さない。scope切替・401時は現行保護を保つ。 |
| 完了画面の結果リンク | 既存`useLinkStatus`のpending表示とpolite通知を利用し、indicator領域の寸法を保つ。 | prefetch済み等でpending表示されない場合も操作を妨げず、fixed durationを入れない。 |
| `/results`初回SSR | 現行のserver lookupとページ内状態を維持する。 | route-level `loading.tsx`、全画面spinner、新しい重複lookupは追加しない。 |

回答中・保存確定・公開確認を同じtask領域の段階として見せ、同じ画面位置のstatus領域を再利用する。長いPOSTをスケルトンに差し替えず、選択した回答を見えるままにする。結果公開確認は保存確定後の別段階として説明し、根拠のない完了率や架空の段階は表示しない。

### 状態の整理

公開状態と通信状態を独立させる。既存の公開判定値は`unknown / waiting / unavailable / visible`等のまま意味を保ち、通信lifecycleは`pending / error / retrying / retry-success / settled`で別途扱う。manual retry successを一度だけ通知し、通常のresume成功は余分な通知を追加しない。

```text
publication: unknown ── lookup pending ── valid response ──> waiting | unavailable | visible
       │                       │
       └── request error/timeout ─────────> unknown + retry guidance + GET-only retry
confirmed result ── background refresh pending/error ──> keep last confirmed result quietly
```

通信失敗やclient timeoutは、公開状態の確定でも回答POSTの失敗でもない。回答状態の復旧が必要な経路は、既存の保存復旧と同じoperation ID/payloadを使う方針を維持し、公開確認の手動retryから回答POSTを呼ばない。

## Technical Key Points

### 状態と通信の責務

- `use-participant-results-visibility.ts` はpublication stateに加えて`lookupStatus` (`pending`, `error`, `retrying`, `retry-success`, `settled`) と明示retry操作を返す。初回、手動、visibility resume、BFCache resumeは共通のsingle-flight GET関数を使う。
- `active`、generation、participant/scope key/epoch、request revisionのstale guardを維持する。error中のunknown stateはvisibilityだけでは再試行せず、手動retryと同時にresume eventが来ても追加要求を起こさない。owner/assisted切替、reauth、phase終了、unmount後に古いresponse・timerが新画面を更新しないことを検証する。
- manual retryは連打を抑え、成功は一度だけpolite statusで通知する。retryボタンがfocus中に消える場合だけ完了見出しへfocusを移し、そうでなければfocusを動かさない。確認済みの値に対するbackground失敗はerror UIへ変えず、最後の確定結果を残す。
- 初回GETが終わらない状況には、読み取りGETだけにAbortControllerと理由を区別できる期限管理を実装する。初期検討値は1 GETあたり15秒で、wall-clockを厳密保証しない。`AbortSignal.timeout()`はactive-timeで進み、timeout signalを直接cancelできない。独自`setTimeout`もbackground throttlingの影響を受けるため、キャンセル可能な自前timerからAbortControllerを中断し、request key/revisionとdeadlineを保持してvisibility復帰とBFCache `pageshow.persisted`の両方で期限を評価する。初回unknown中のtimeoutは公開状態をunknownのまま保ち、GET状態だけを手動再確認可能なerrorにする。確定済み結果のbackground refreshがtimeoutした時は前回の確定表示を保ち、spinnerやerror UIを出さない。timeoutによるabortだけが初回unknownの回復案内対象で、request置換・identity変更・complete phaseからの離脱・unmountによるabortでは回復案内を出さない。古いresponseや`finally`が新しいrequestのpendingを消さないようにし、request終端、complete phaseからの離脱、scope変更、reauth、unmount時に自前timer/listener/handlerを片付ける。
- POSTにtimeout/abortを適用して保存失敗と断定したり、新しいoperation IDで自動送信したりしない。保存状態が不明な時の既存retry契約（同一operation ID・payload）を維持する。

### 待ち時間と表示

- 公開GET期限の初期候補は15秒であり、実際の通信分布と手動テストから見直す。POSTの長待ち文言はまだ実装せず、実測で必要性が確認された場合に閾値と説明文を別途評価する。
- 進捗率、架空の完了時刻、通信測定なしの「保存を確認中」は出さない。時間で回答保存・公開判定の成否を推測しない。長待ち閾値は文言の補足だけに使い、GET期限は通信待ちを終えてunknownのまま手動再確認できるようにするために使う。毎秒aria-live通知を更新しない。
- skeletonは初回の未取得領域だけに置き、確定情報や選択中の回答を置き換えない。最終コンテンツに近い高さとspinner幅を確保してCLSを抑える。通信反応を隠す人工の最低表示時間は設けない。装飾的なspinner/skeletonの出現delayは、短い通信でのちらつきを計測した後に限り任意調整できる。文字による状態案内、送信受付、同期lockは即時に更新する。

### アクセシビリティ

- status通知は一か所に集約する。`role="status"`（polite）を`aria-busy`領域の外側に置き、busy解除まで読み上げが保留されたり、button・spinner・補足文で同じ案内を重複したりしないか確認する。
- skeletonは`aria-hidden="true"`とし、利用者には意味のある単一statusを読み上げる。`aria-busy`は実際に更新中の領域へ付け、正常なwaiting/unavailableや背景refreshには付けない。
- retry buttonは再確認中も同じ位置に保つ。キーボードで開始・終了でき、retry後のfocusを失わない。画面状態を見出しで移す必要がある場合はforegroundの確定遷移に限り、既存の401 reauth focusを優先する。背景更新・遅延タイマーでfocusを奪わない。
- 既存`Spinner`/`Button`のloading表現とreduced-motion対応を再利用する。任意pulse/shimmerは`prefers-reduced-motion: reduce`で停止し、状態文は残す。新アニメーション依存や長い装飾動作は加えない。

### 技術選択と非対象

- 回答送信はclient fetchである。`loading.tsx`やServer Componentの`Suspense` boundaryはroute/server readの待ちを表すもので、POST待ちの代用にしない。
- 送信受付と同期二重送信ガードはurgentな更新として直ちに反映する。`useTransition`はasync Actionも含む更新のpending期間を表せるが、そのpending自体はサーバーでの保存成功・公開判定確定の根拠ではない。React ViewTransitionが反応するtransition更新などと通常のurgent `setState`を混同しない。
- `useFormStatus`はform Action配下のフォーム状態参照、`useOptimistic`は仮表示に適する。現状で有効な変更が示されない限りServer Actionsへ移行しない。仮表示は通常の回答選択等に意味がある場合は評価できるが、未確認の保存・公開成功は表示しない。
- 結果リンクには既存のsemantic Next Linkと`useLinkStatus`を活用する。reactCompilerや新しいtransition APIがclient POSTや`no-store`の公開状態GETを高速化すると仮定しない。
- HTTP/DB schema、回答API応答、回答POSTの挙動は変更対象外。hook内部の返却値・状態と利用者向け表示の拡張が必要なら、仕様書のrequirements/API記載を実装と同期する。

## 実施順と対象ファイル

### Step 0 — 表示条件・基準を確定

1. `phase=complete`になる全経路について、正常POST、正常復元、restoreError、ID不一致、409再取得のそれぞれに保存確定の証拠があるか対応表にする。phaseだけで判定しない。
2. throttled network、遅延応答、失敗、background復帰/BFCacheからの復帰を使ってpending文言・待ち時間・通信終了を測る。GET期限は保存deadlineとrequest key/revisionを復帰時にも検査し、timer callbackが遅れた時に古いrequestを新状態へ反映させない。
3. processing milestoneには`performance.mark/measure`を使えるが、`setState`直後のmarkを実際に画面へ描画された時刻とは見なさない。クリック後の描画応答はINP、Event Timing、またはDevToolsのtraceで調べ、アプリのPOST/GET区間とは別に評価する。
4. INPのfield p75 <= 200msという「良好」基準は参照値に留める。ローカル未計測SLOとせず、CLSの前後比較とあわせて基準値を作る。GET期限の初期候補は実際の分布を見て見直し、POST長待ち文言は必要性を測定する。

実装前コード監査で確認した保存根拠:

| `complete` 経路 | 保存確定根拠 | 保存済み案内 |
| --- | --- | --- |
| 正常POST (`use-quiz-session.ts` batch success) | 返却 `submissionId` の一致、選択状態の保存、返却revisionの適用後に完了 | 可 |
| 正常復元 (`restoreSavedAnswers`) | latest submission取得、設問取得、保存内容の整合性検証後に復元 | 可 |
| restoreError付き復元 | 設問取得失敗または保存内容不整合 | 不可。回復表示を維持 |
| POST返却ID不一致 | 要求IDと返却IDの不一致 | 不可。回復表示を維持 |
| 409後のinvalid restore / 明示refresh不正保存 | `InvalidSavedSubmissionError` | 不可。回復表示を維持 |

Step 0の保存確定根拠表はコード監査とテスト要件に反映済み。production route probeではローカル合成回答flowについてlogin→first question 133.1ms、submit→completion 83.8msを観測したが、即時mockのため実ネットワーク/DB分布を示さない。throttled/delayed/failing network、background/BFCache復帰、INP/Event Timing、answer CLS、POST/GET通信分布の実測は未実施。15秒のGET期限は暫定候補のままで、POST長待ち文言は必要性未確認のため延期。遅延源を示す計測がないためP2は提案していない。性能改善やSLOの達成を主張せず、実通信・manual browser validationをフォローアップとして残す。

### P0 — unknown recoveryと確定案内

1. `use-participant-results-visibility.ts`に通信lifecycleと明示retryを追加し、公開状態はunknownを維持したまま手動GET再確認へ進める。GET timeoutを採用する場合は、表示とrequest cleanupを一緒に実装する。
2. `quiz-runner.tsx`で通信終了後の案内・retryを実装。初回失敗とretry失敗を区別し、retry pending・success・再失敗を一度だけpolite statusで知らせる。
3. `use-quiz-session.ts`の保存根拠を確認し、保存確定ラベルは正常POST/正常復元で確認できた場合だけ表示する。restoreError等は既存の回復表示を優先し、誤った成功案内を避ける。
4. `openspec/specs/stcirt/spec.md`のR2/R3、アクセシビリティ要件および関連API/state記載を同時に更新する。仕様書にあるPlan 99由来の「初回通信失敗後はloadingを維持」「初回とtab復帰だけ」の要件を、手動retry・通信期限・confirmed background refreshと一貫する形に更新する。正常な非公開状態とunknown errorの区別は明記し、Plan 99本文は履歴として保持する。

### P1 — 初期骨格とpending表示

1. `quiz-runner.tsx`の設問load表示を、最終カードに合わせた非操作skeletonと短いstatusに置き換える。既存load error retryを維持する。
2. 送信中は既存ロック/選択保持を維持する。POST長待ち文言は通信分布から必要性が測定で確認されるまで追加しない。
3. 必要最小限の共通UI/CSSと共通Spinner/Buttonを使う。既存`useLinkStatus`の表示寸法・通知を再利用する。

### P1b — React 19.3更新とViewTransition導入

1. `package.json`をReactとReact DOMが同じ19.3系patchとなるよう更新し、`pnpm-lock.yaml`も同期する。既存のReact型定義との整合が必要なら同工程で更新する。React Compiler設定は有効なままproduction buildで確認する。Next.js 16.4.2との組合せをbuild・hydration・既存`motion` 14.2との共存で検証し、対応に必要と公式情報またはその検証結果から分かった場合のみNext.jsのcompatible patchを合わせて更新する。16.4.3を最低版と先に決めない。
2. `<ViewTransition>`を使う最初の対象を、保存が確定した後の同一`/answer`内の小さな状態表示領域に実装する。保存確認後の次の状態へReactがtransitionとして処理する切替に適用し、境界の詳細は既存実装に合わせる。全画面snapshotや認証SSRをまたぐ`/answer`→`/results`遷移は対象外とする。
3. 即時に必要なPOST受付、同期lock、二重送信防止、現在の選択内容はtransition境界の外で保つ。ViewTransitionは表示切替だけに用い、通信中の待ち時間を埋めたり、サーバー確定を遅らせたりしない。状態文、`useLinkStatus`、focusもアニメーションから独立させる。
4. 対応ブラウザーでは限定した表示切替を行い、非対応ブラウザーと`prefers-reduced-motion`では同じ内容を通常表示する。対象範囲で操作応答・INP・メモリ・視覚負荷に実測上の悪化があれば演出を縮小または無効化し、依存更新後も通常の機能を保つ。実測前にINP改善を断定しない。
5. `openspec/specs/stcirt/spec.md`の回答待ちと完了表示要件に、確定後の限定transition、通常表示へのfallback、reduced motionを記載し実装と同期する。HTTP/API responseやDB schemaの変更は想定しない。

React 19.3の`<ViewTransition>`はstable機能であり、依存更新はユーザーから許容済み。Next.jsとの実互換性確認は実装検証工程であり、追加の承認gateではない。[React 19.3](https://react.dev/blog/2026/09/09/react-19-3) [Next.js View Transitionsガイド](https://nextjs.org/docs/app/guides/view-transitions)

### P2 — 実測で根拠がある場合の遅延改善

- まず依存関係を持つrequest waterfallと、並列実行できるreadを分け、独立readの安全な並列化、重複GET削減、既存Next Link prefetchの実測を行う。Next prefetchはclient POSTや`no-store` GETを速めず、未クリックでもdynamic routeのserver処理を発生させる場合がある。認可、scope、鮮度を確認し、既存挙動を測ってから候補を絞る。[Next.js prefetching](https://nextjs.org/docs/app/guides/prefetching)
- Cache Components/Partial Prefetchingは『実験機能だから』という理由で除外しない一方、現在の`/results`の認証・force-dynamic/SSR契約への影響を個別に評価する。Cache Componentsはprerender validationを広げ、`cookies()`/`headers()`等の使用位置やSuspense境界の構造変更が必要になる場合がある。Partial PrefetchingもCache Componentsを要する。client POST待ちには適用しない。
- Speculation Rulesは文書ナビゲーションのprerenderを主に扱うため、App Router client navigationや回答POSTの代替として採用しない。[Chrome: prerender pages](https://developer.chrome.com/docs/web-platform/prerender-pages)
- P0/P1後も明確な遅延源がある場合に限り、対象区間・利用者影響・比較方法と安全性の根拠を添えて別途提案する。認可を越えたprefetch、ユーザー別データの不適切な共有cache、SSE/WebSocket、自動pollingはこの計画から導入しない。

想定ファイル:

- `src/app/answer/quiz-runner.tsx`
- `src/app/answer/use-participant-results-visibility.ts`
- `src/app/answer/use-quiz-session.ts`（保存確定根拠を表す既存状態を確認し、必要な場合だけ小さく内部状態を整理）
- `src/components/Spinner.tsx`、`src/components/Button.tsx`、`src/app/globals.css`のうち表示を正しく共有できる最小範囲
- `package.json`と`pnpm-lock.yaml`（React/React DOMを同じ19.3系patchへ更新）。型定義やNext.js patchは互換確認で必要になった場合だけ同じ工程に含める。
- React `ViewTransition`の導入箇所となる`/answer` UIと、対応する仕様記述
- `openspec/specs/stcirt/spec.md`
- 関連する既存unit/component testsと、必要な場合だけE2E

## 受け入れ基準と検証計画

| 条件 | 期待する結果 | 主な確認先 |
| --- | --- | --- |
| 高速load/POST/公開GET | 人工的な最低表示時間やちらつきを追加しない。確定後にspinnerが残らない。 | completion/submission unit tests、手動ネットワーク検証 |
| 遅いload/POST/GET | 実際の対象処理を案内する。POST長待ち補足は通信分布の実測で必要性が確認されるまで追加しない。GET期限で保存/公開結果を推測しない。 | throttled network、fake timersを使う既存suite |
| 初回GETのnetwork/HTTP非401/malformed/timeout失敗 | 公開状態はunknownのまま、静的説明と手動retry。未確認CTAを出さない。 | `tests/answer/quiz-runner-completion.test.tsx` |
| 手動retryの成功・再失敗・多重click | GETのみ実行。成功すればvalid stateに遷移して一度だけpolite status、再失敗時は再案内。retryボタンがfocus中なら成功後に完了見出しへfocusを移し、それ以外はfocusを動かさない。visibility/BFCache resumeとsingle-flightを共有。 | completion test、visibility hook test |
| 401 / reauth | retry表示が再認証導線を覆わず、既存focus/復旧を維持。 | `tests/answer/quiz-runner-reauth-focus.test.tsx` |
| owner/assisted切替、unmount、遅い旧response | 旧stateやtimerが新しいscope/画面へ反映されない。 | completion/hook race tests |
| background/BFCache復帰とGET期限 | 期限callbackの遅延をwall-clock保証と誤認しない。復帰時deadlineを再評価し、同時visibility refresh/manual retry・abort・古い`finally`が新しい状態を壊さない。 | hook race tests、background/restoreを含む実機確認 |
| confirmed resultのbackground refresh | pending・失敗でも前回の確定結果を静かに保持。自動pollなし。 | completion tests、results tests |
| POST retry・二重送信 | 選択保持、operation ID/payload保持、回答POST二重送信なし。公開retryは回答POSTを呼ばない。 | `quiz-runner-submission.test.tsx`, `quiz-runner-save-recovery.test.tsx` |
| save restore error / response ID mismatch / 409 invalid restore | `complete`だけを理由に保存済みと案内しない。既存回復表示を保つ。 | `use-quiz-session`/completion/save recovery tests |
| keyboard・読み上げ・motion reduction | retryをkeyboard操作可能。Status Messages (WCAG 2.2 SC 4.1.3)を満たすようfocusを奪わず通知する。status重複なし。reduced motionで装飾動作を抑え、文言は残す。 | component tests、手動SR/reduced-motion確認 |
| `/results`初期表示 | 認可済みlookup後に既存ページを返す。route-level spinner/shellなし。 | `tests/results/results-page.test.tsx`, `tests/e2e/results.spec.ts` |
| P1b ViewTransition導入 | React/React DOMの19.3系更新後、build・hydration・既存motionとの共存を確認する。非対応browser、reduced motion、機能offでも同じ状態内容へ通常切替できる。通信・操作完了を動きで遅らせず、実測で悪化すれば演出を縮小/無効化する。 | production build、対象browser実機、手動focus/motion確認 |

既存の`tests/answer/quiz-runner-completion.test.tsx`、`quiz-runner-submission.test.tsx`、`quiz-runner-save-recovery.test.tsx`、`quiz-runner-reauth-focus.test.tsx`、`tests/results/results-page.test.tsx`、`tests/e2e/answer.spec.ts`、`tests/e2e/results.spec.ts`を優先する。test implementationはfixer、実行と検証gateはOrchestrator担当。各実装に意味のある状態境界の回帰検証を追加し、実装をなぞるだけのテストは増やさない。

React/React DOMの依存更新とViewTransition導入では、related testsに加え、全unit/coverage、type-check、lint、format、spec refs/security、production build、回答と結果のE2Eを検証する。現在はunit/coverage・typecheck・lockfile・format・oxlint・security・spec refs・E2E・production webpack buildが上表の通りPASS。production route probeも実施したが、合成即時APIのflowであり、実ネットワーク分布・throttling・INP/Event Timing・answer CLSを検証しない。依存更新後の実ブラウザーhydration、既存motion共存、実BFCache、実スクリーンリーダー、manual reduced-motion/ViewTransition fallback確認は未検証。Playwright用loopback listen許可は`127.0.0.1:3001`のみ。hooksを無効化する設定や`--no-verify`を使わない。

評価指標:

- 処理中に説明のあるpending状態が表示されるか。
- 読み取り通信終了後にspinnerが残るケースが0か。
- 同一操作に対する重複保存が0か。
- skeleton追加前後の主要画面CLS。操作→最初のpending描画応答（INP/Event Timing/DevTools等）、POST開始→保存確定、保存確定→公開状態終端、結果Link操作→結果表示の処理区間を別々に測る。`performance.mark`は呼び出し位置の処理milestoneを示すものであり、`setState`直後のmarkも実描画完了を示さない。
- 必要な場合のみ既存の`next/web-vitals`やRUMの導線を再利用する。初期評価はローカルとDevToolsから始め、外部telemetry送信、新規依存、query・participant・payload・認証値の記録を追加しない。
- 計測結果からベースラインを作る。ユーザーの回答内容、氏名、認証情報は記録しない。測定前に固定SLOを約束しない。

## Technical Key Points 要約

- 結果の公開状態と通信pending/errorを直交する状態として表す。失敗はunknownから別の公開状態への変換ではない。
- 保存成功の案内はHTTP成功とID/revision確認、または妥当な保存済み回答の復元という根拠がある時だけ行う。phase名だけを根拠にしない。
- 手動retryは参加者results GETに限定し、single-flight・scope token・stale response guard・unmount cleanupを維持する。初期期限を採用する場合、GETが停止したことだけを確定し、保存/公開の失敗とは扱わない。
- 回答POSTの既存ロック、draft保持、同一operation ID/payloadでの再試行を保つ。確認GETの再試行と回答POSTの再送を混同しない。
- skeleton、固定寸法indicator、単一polite statusで視覚的な待ちと読み上げを整える。reduced motion、focus、背景refreshのquiet behaviorを含めて検証する。
- client mutationにはroute-level Suspenseを流用せず、既存Next Link pendingとSSR結果lookupの契約を維持する。React/React DOM 19.3系更新とViewTransition導入はユーザー許容済みの工程であり、React 19.3でstableな機能を同一`/answer`内の限定範囲に適用する。測定根拠なしの他API追加や、`cacheComponents`の一括有効化を行わない。

## 参考資料

### リポジトリ内

- `openspec/specs/stcirt/spec.md:123-145,153-170,247,560-567`
- `src/app/answer/quiz-runner.tsx:29-48,256-264,666-673,713-721`
- `src/app/answer/use-quiz-session.ts:645-698,1110-1138,1161-1189,1240-1276`
- `src/app/answer/use-participant-results-visibility.ts:69-143`
- `src/app/results/page.tsx:21-85`
- `src/components/Spinner.tsx`, `src/components/Button.tsx`, `src/app/globals.css:78`
- `shared_plan/98-RESULT_NAVIGATION_LOADING_SPINNER_FIX_PLAN.md`
- `shared_plan/99-PUBLICATION_STATUS_COMPLETION_LOADING_PLAN.md`
- `shared_plan/101-WEB_UI_INTERACTION_IMPROVEMENT_PLAN.md`
- Next local docs: `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-link-status.md` and `01-app/02-guides/interactive-apps.md`.
- Next prefetch/view transition docs: `01-app/02-guides/prefetching.md`, `01-app/02-guides/view-transitions.md`, `01-app/02-guides/adopting-partial-prefetching.md`.
- Next cache/prefetch config docs: `01-app/03-api-reference/05-config/01-next-config-js/cacheComponents.md`, `01-app/03-api-reference/05-config/01-next-config-js/partialPrefetching.md`, and `01-app/03-api-reference/03-file-conventions/02-route-segment-config/prefetch.md`.

### 公式資料

- [Next.js: useLinkStatus](https://nextjs.org/docs/app/api-reference/functions/use-link-status)
- [Next.js: Linking and Navigating](https://nextjs.org/docs/app/getting-started/linking-and-navigating)
- [React: useTransition](https://react.dev/reference/react/useTransition)
- [React DOM: useFormStatus](https://react.dev/reference/react-dom/hooks/useFormStatus)
- [React: useOptimistic](https://react.dev/reference/react/useOptimistic)
- [React 19.2: Activity and useEffectEvent](https://react.dev/blog/2025/10/01/react-19-2)
- [React 19.3: ViewTransition stable](https://react.dev/blog/2026/09/09/react-19-3)
- [Next.js: View Transitions guide (updated 2026-10-15)](https://nextjs.org/docs/app/guides/view-transitions)
- [Next.js: Prefetching](https://nextjs.org/docs/app/guides/prefetching)
- [Next.js: Cache Components](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents)
- [web.dev: INP](https://web.dev/articles/inp)
- [MDN: AbortSignal.timeout()](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static)
- [MDN: AbortSignal.any()](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static)
- [MDN: setTimeout() background throttling](https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout)
- [W3C: WCAG 2.2 Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
- [Chrome: prerender pages](https://developer.chrome.com/docs/web-platform/prerender-pages)
- [MDN: ARIA status role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/status_role)
- [MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)

資料は2026-10-30時点の判断根拠である。stable APIであることのみを採用根拠とせず、lock構成・認証契約・ユーザー待ちの区間で価値があることをpilotと実測から確認する。
