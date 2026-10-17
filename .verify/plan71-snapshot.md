# プレゼンテーションのスライド送り高速化計画

- 作成日: 2026-10-17
- 状態: **Phase 0 verified run完了・runtime改善未採用**（計画作成時点では未実測）
- 対象: 認証済み操作画面のwarm状態におけるスライド送り。別画面への反映速度は改善対象外とする。
- 関連計画: [35-PRESENTATION_ADMIN_SCROLL_LATENCY_PLAN.md](./35-PRESENTATION_ADMIN_SCROLL_LATENCY_PLAN.md)
- 関連性能報告: [presentation-plan35.md](../docs/performance/presentation-plan35.md)
- 仕様根拠: [stcirt/spec.md](../openspec/specs/stcirt/spec.md) のR7 `:316-343`、R8 `:402-406`、Presentation API `:575-583`

## 目的と背景

操作画面のwarm状態で、入力から次のスライドがユーザーに見えるまでを、正しさとデータ保護を保ちながら可能な限り短くする。まず実測で待ち時間の位置を特定し、操作前の同期待ちや表示処理が支配的な場合に限って該当箇所を改善する。cold開始より、読み込み済みdeckでの通常ページ送りを優先する。

操作画面は `src/app/presentation/presentation-screen.tsx:613-652` でcontrolsを取得し、必要な場合にのみ同revisionのdeckを読み込む。`src/app/presentation/presentation-screen.tsx:726-795` はpollのsingle-flight、可視状態、visible復帰時の更新、通常約2500ms間隔のpollを扱う。操作処理は `src/app/presentation/presentation-screen.tsx:846-909` にあり、現状では進行操作を始める前にactive pollの完了を待つ。

35番で既に実装済みの操作画面のoptimistic表示、メモリ内deck再利用、通常成功POST後の追加session/controls GET省略、controls-only DB経路とその計測結果を、この計画で新しい改善として数え直さない。これらを現状の基線として扱う。今回の計画作成時点の実測はなく、操作前poll待ち、重いReact描画、fit/layout、DBやネットワークが体感の原因だとは断定しない。

## 既知の仕様と制約

- R7のsingle-flight契約では、操作中に到着した入力を無視する。待機入力を保持する変更は仕様変更となる。
- 操作画面は認証済みcontrolsと対応するrevisionのdeckを使い、通常のスライド送りでslide内容を再取得しない。成功POSTの5 controlsを実行時検証して反映する。401時はprivate controls/deckを消去する。
- POSTは操作IDとsnapshot revisionを用い、mutationの自動再送は禁止。409、通信失敗、異常な成功本文などでは既存どおりauthoritative stateへ再同期する。
- controls/deckが初期、無効、欠落、またはrevision不整合なら、推測した隣接slideへ進めず、同期が確立するまで操作を無効にする。
- R8の全stage共通fit・内容の完全表示・no-scroll/no-clip/no-paginationは仕様 `openspec/specs/stcirt/spec.md:402-406`、reduced motionは`:387-390`、簡潔なlive announcementは`:372-376`に従う。
- 次POSTの開始時刻はmutation lock解除そのものではない。入力可能時刻は別指標として測る。

## 既存の証拠と限界

- `shared_plan/35-PRESENTATION_ADMIN_SCROLL_LATENCY_PLAN.md` は管理者操作のPOST応答活用、軽量同期、競合と失敗時の復旧を実装・仕様更新・検証済みとして記録している。本計画はその後続である。
- `docs/performance/presentation-plan35.md` はChromium、mock HTTP delay 50ms、browser各操作n=10、local file-backed DB各action n=40の比較を記録する。そこではwarm操作の入力→DOM更新+2 rAFの代理指標が概ね16–127msだが、DOM+2 rAFはpaint完了ではない。swipeではgesture時間を含みうる。HTTPはmock、DBはlocal fixtureであり、本番RTTやTurso性能へ外挿しない。
- `scripts/measure-presentation-latency.mjs` は既存のPlaywright測定器である。入力からDOM mutation+2 rAF、POST/GET観測、次操作受理proxyなどを取る。次操作受理proxyは逆方向入力probeの2回目POST開始で、内部lock解除の直接測定ではない。pollと重なるGET件数は操作起因GETと断定できない。
- 既存測定のサンプル数、fixture、mock遅延は条件比較には有用だが、今回のユーザー視認速度改善をそれだけで証明しない。既存scriptのswipe値は `scripts/measure-presentation-latency.mjs:589-607` のmouse move steps=5を含むgesture生成時間を起点にするため、約100msの差をアプリ固有遅延と断定しない。

## 技術的キーポイント

| 論点             | 実装上の扱い                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 入力から画面表示 | handler開始、DOM変化、2 rAF、必要なら録画/traceを分ける。2 rAFは視覚完了の代理値と明記する。                                                                                                                                                                                          |
| pollとの競合     | 既存のgeneration/sequence保護は一部実装済み。poll待ちを外す場合は、mutation開始時点の無効化、stale pollのstate/deck書込、古いfinallyによるflight/lock解除まで、既存保護の適用範囲とタイミングを拡張する。                                                                             |
| 送信順           | POST mutationは直列を維持する。送信前poll待ちを外してPOST自体を早める案は、server CAS、expectedSnapshotRevision、409時rollback/reconcileとの整合を確認後に別途採否判断する。                                                                                                          |
| optimistic表示   | 操作開始時にcontrols/deckが同じ確定状態を示すときだけ先行表示する。送信後は検証済みPOST応答を権威値とし、失敗時は確定projectionへ戻して再同期する。                                                                                                                                   |
| 状態保持とロック | 操作開始世代とpoll世代を照合する。abortは通信資源節約の補助手段であり、stale結果を採用しない保証の代替にしない。次POST開始proxyと入力受付解除を別々に記録する。                                                                                                                       |
| 描画とfit        | `src/app/presentation/presentation-screen.tsx:1094-1169` のfitは初回同期measureと通知時rAFを使い、操作側はfit完了をawaitしない。fitが支配的とtraceで分かった場合のみ対象を絞り、全stageとviewport保証を崩さない。初期ready=falseは`:1235-1240`で表示を隠すため、ready遷移も確認する。 |
| API/DB           | schema、transaction serialization、idempotency、5-field controls、既存controls-only経路を保つ。DB変更はtraceで支配的と示された場合だけ検討する。                                                                                                                                      |

## Phase 0 — 基準計測と原因の切り分け

1. 同一commit・同一依存・同じbrowser/device・viewport・データfixture・可視状態でbaselineを取る。比較対象コードが変わる場合も同じ条件を保ち、設定値を記録する。
2. 実ネットワークの計測とmock計測を別の結果群にする。mock結果はクライアント処理の切り分けに使い、実ネットワーク結果と混在させない。mock遅延、server、DB、browser、device、OS、refresh rate、viewport、cold/warm状態を記録する。
3. 主要操作・条件は原則各n=30以上を集め、p50/p95とnを報告する。失敗、外れ値の除外規則、欠測を明記する。既存scriptの既定n=5やplan35のn=10を今回の確定根拠にしない。
4. 主要操作5種（keyboard advance/previous、click advance、swipe advance/previous）について、入力イベントからDOM更新+2 rAFまでを個別に採る。keyboardは `src/app/presentation/presentation-screen.tsx:921-945`、clickは`:1003-1018`で入力処理からoperateまで即時で、keyup/timeout待ちはない。click handlerも同イベント内でoperateを呼ぶ。swipeは`:1020-1070`でpointerup時に `|dx| >= 56px` かつ横移動が縦移動の1.35倍超で成立する。450ms timerはswipe後の誤click抑止だけで、page送りcooldownではない。計測ではgesture完了→表示とgesture全体を分ける。これは**代理指標**であり、実際の視覚的paint/scan-out完了ではない。可能なら同条件の画面録画またはbrowser traceで視認変化を確認し、代理指標と分けて報告する。
5. 操作画面では入力からPOST開始、POST完了、入力受付再開を分けて測る。入力受付再開は2回目POST開始proxyだけに頼らず、再入力を受けた時刻も記録する。busy中のlost input数も記録する。
6. cold loadは参考値にとどめ、warm操作、pollと操作の重なり、低速/失敗応答、境界stage（開始/終了/空deck/順位遷移）、大きなdeck/長文データを対象条件に含める。5連続操作は主要操作5種とは別のburst条件として測る。swipeではgesture開始から完了までと、gesture完了から表示までを分ける。
7. 対象実機が60Hzなら、warmかつcontrols/deck整合済みの操作についてkeydown/click/swipe成立後のDOM+2 rAF p95 ≤ 50msを暫定目標に置ける。実測で基準値と実利用端末を確認してから確定する。swipe gesture全体の時間を同じ目標へ混ぜない。
8. 35番で既に守られたGET省略、deck GET回数、成功時の操作起因request数、DB query数を回帰基準にする。poll偶然のrequestを操作起因と数えない。正しさ、5 controls、revision一致、fit品質を性能指標のために落とさない。
9. 計測結果で分岐する。a) 入力→POST開始の待ちが支配的なら、送信前poll待ちを切り離す案の安全性を評価する。b) POST完了→受付再開が遅いなら、確定処理と必要な再同期を調査し、正しさの保証を維持する。c) DOM commit→表示が遅ければPhase 1b。d) DBが支配的ならPhase 3候補。e) 明確な支配箇所がなければ、変更を加えず改善案を再評価する。

## Phase 1 — 操作画面の確定状態を使った即時表示

- 既存のoptimistic表示を保ちつつ、poll flight完了を待つ前に表示できる条件があるか検証する。mutation開始時に現操作世代を進め、先行pollを無効化してから、整合済みcontrolsとdeckに基づき次のprojectionを一度だけ描画する。
- controls/deck参照が初期、null、別revision、操作境界不整合なら先行描画・POSTを行わず、従来の同期/操作不可挙動を維持する。
- 既存poll generation/sequenceの導入済み部分を再利用する。先行pollのcontrols、deck、error state、およびfinallyのflight/lock処理が新世代を上書き・解除しないよう、generation比較の開始点と全書込点を監査して必要箇所へ広げる。
- POSTは直列。各POSTの基準は直前に権威確定したcontrols。先行操作の結果が確定していない状態から次操作の目標stateを積み重ねない。
- POST開始もpoll完了待ちから切り離す案は任意の別決定点とする。APIがexpected snapshot revisionとoperation IDを検証する範囲、CAS/transaction順序、409率、失敗時のprojection rollbackとcontrols/deck再同期を確認する。競合時の重複・逆順適用を防げないなら採用しない。
- 5 controlsのruntime validation、通常成功時の追加GET省略、revision変更時のdeck再取得、401時のprivate data purge、409/失敗のrollback/reconcile、POST自動再送禁止を維持する。
- 失敗後の復旧にdeck再取得が必要な場合がある。その必要ケースを明記し、成功時の通常進行でGET 0件という契約と混同しない。

## Phase 1b — 描画経路の短縮（計測で支配的な場合のみ）

- traceで支配的だったReact再render、同期layout、fit再計算だけを絞る。memo化や状態分割は実測とコード上の依存を根拠に選び、更新漏れ・stale closure・deck revision跨ぎを検証する。
- 既存fitは全stage、viewport、font、image、content変化に追従する。再計算を減らす場合も必要なResizeObserver/font/image/viewport経路を失わない。
- transition/アニメーションによる体感短縮は、入力後すぐ内容が明瞭に見えることを録画で確認する。切替中の旧slide混在や読み上げ誤通知を許容しない。reduced motionでは動きを抑える。
- Next.js Link prefetchは同一route内のstate遷移を直接速める仕組みではない。ローカルのNext docs確認範囲に限って判断し、route移動や初期ロード上の直接根拠がなければこの操作に導入しない。

## Phase 2 — 待機入力の保持（任意の仕様変更）

R7はsingle-flight中入力無視を契約しているため、待機入力を保持する場合は仕様変更として扱い、Phase 0/1の完了後に別判断する。第一候補は上限付きFIFO queueだが、queue上限、overflow時に利用者へ示す方法、keyboard repeat/click/swipeの共通意味、失敗時にqueueを停止・破棄する条件、再確認させる条件を設計してから実装する。

POST並列化とmutation自動再送は禁止のまま維持する。advance/previousの同方向合成やlatest target方式は、quiz finish、winner/rank skip、deck boundary、戻る操作など副作用を変え得るため一律採用しない。画面をqueueの末尾まで先読みする場合は表示とserver確定位置が長く乖離するため、初期案では表示先行を1操作までとする。失敗時は権威controlsに戻し、残queueを実行するか破棄するかを明示する。

## Phase 3 — DB処理（計測で支配的な場合のみ）

DB処理が実ネットtraceで操作時間の支配要因と確認された場合に限り、既存処理経路を調査する。35番で完了済みのcontrols-only読取や重複GET省略を再提案しない。変更案はtransaction serialization、state/version CAS、operation IDのidempotencyを維持できることを示し、必要queryと不要queryを実データで分類する。DB計測値をHTTP/UI latencyと混同しない。

別画面への反映速度は今回の改善対象外とする。

## 変更候補と仕様同期

| 候補                                                        | 目的・条件                                                                           | 仕様更新                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `src/app/presentation/presentation-screen.tsx`              | Phase 1のpoll/mutation世代境界、計測時のみfit/render経路、またはPhase 2の入力queue。 | R7の操作即時表示、single-flight/待機入力契約、stale poll/rollbackと同期中の挙動。 |
| `src/app/presentation/presentation-screen.module.css`       | Phase 1bで視認改善にCSS transition等が必要と測定・録画で分かった場合のみ。           | R8のreduced motion、全stage fit・読みやすさ保証。                                 |
| `src/app/api/admin/presentation/route.ts` と関連 repository | POST開始待ちやDB処理が支配的で、API整合の変更が必要な場合のみ。                      | R7とAPI POST応答、revision、409、operation ID、同期と再送禁止契約。               |
| `tests/app/presentation/*` および必要なAPI/DBテスト         | 挙動を意味のある境界条件で固定する。                                                 | 仕様更新と同じ変更内で同期。                                                      |

仕様同期の主対象はR7 `openspec/specs/stcirt/spec.md:316-343`、描画や入力挙動を変える場合のR8 `:402-406`、API変更時のPresentation API `:575-583` とする。今回の計画保存では仕様本文、実装、API、DB schemaを変更しない。既存controls-only DB改善を繰り返さない。DB処理は測定で支配的と示された場合に限りPhase 3の改善候補とし、transaction serializationとoperation idempotencyを守り、同じ軽量化を二重実装しない。

## 実装順と意味のある検証

1. Phase 0の計測手順を実行し、比較条件、p50/p95/n、実ネット/mockの分離、視認確認、原因箇所、採用phaseの根拠を性能報告に残す。
2. Phase 1を小さく実装する場合、操作開始直後の整合済みcontrols/deck、stale poll抑止、stale finally、連続操作直列性をテストする。テストは操作中に古いpollが遅れて成功/失敗する条件、POST成功/409/401/5xx/通信不明、revision変化、境界stageを含める。
3. 既存画面テストで5 controls validation、正常成功の追加GETなし、deck revision更新時のみ取得、rollback、401 purge、操作受付lock、読み上げ/reduced motion/fit保証を確認する。必要な追加テストは本番挙動を検証し、実装の単なる再記述にしない。
4. Phase 1bは対象render/fit経路のtraceを再採取し、既存no-scroll/no-clip/長文/大deck/viewport resize/font/imageロードの回帰を確認する。
5. Phase 2を選ぶ場合はR7要件、keyboard repeat、click/swipe統合、queue上限とoverflow、境界・失敗時処理を先に確定し、それを直接検証する。
6. DB改善を選ぶ場合はtransaction serialization、operation idempotency、既存のcontrols-only経路との重複、SQL/query数と実ネットへの影響を検証する。
7. 変更後は同一条件のbaselineとcandidateを比較する。E2E/UI/API/DB層の差分に応じた必要範囲を選び、性能数字だけでなく操作結果、auth、revision、追加GET、fitを検証する。
8. 実装時は既存の必須hookを実行する。テスト作成は実装担当、lint/type-check/test/coverage/spec-refs/smoke/E2Eの検証実行はOrchestratorが担う。必要なローカル検証serverは許可された `127.0.0.1:3001` のみでlistenし、`0.0.0.0` は使わない。worktreeは指定検証script以外で作成しない。

## 完了条件

- 同一条件のbefore/afterで、採用した箇所の入力→表示、POST開始/完了、受付再開を個別に比較し、p50/p95/nと実ネット/mock環境を示す。
- 目標はPhase 0後に確定し、暫定目標を達成値と誤記しない。未達なら値を明示し、実視認の改善を代理指標だけから主張しない。
- 正しいslide遷移、操作のsingle-flightまたは合意済みqueue挙動、revision一貫性、失敗rollback/reconcile、401 purge、既存の成功時GET節約、POST自動再送なしを保つ。
- すべてのstageが既存R8のfit/readability/reduced motion条件を満たし、既存の公開情報境界に影響しない。
- 実装変更と同時にR7/R8/API節を同期し、意味のあるテストと必要な検証gateを通す。

## 今回の実施記録

- 計画作成時点の記録: 共有計画71番を新規作成した。runtime実装、仕様変更、計測、テスト実行はしていない。
- ユーザー回答により、改善対象を操作画面に確定した。別画面への反映速度は対象外。

## Phase 0 実施報告と計画照合

以下は2026-10-17に取得されたverified runner JSONの要約である。元の計画本文は作成時点の記録として保持し、この追記で「今回実測なし」を更新する。結果JSONのsource fingerprintはSHA-256 `24b39b87286a1bf5512aabbe42d8003a563555d754b2123ea6e4215dc5f854c8`、commit `02ef03ab00a5e4d973802a89b4db6ea6f8e980fc`。mock/realとも主要5操作は各n=30/30、run statusは`complete`、scenario incompleteは0。外れ値はTukey 1.5 IQRで数えたが、サンプル除外はしていない。

### 再現条件

| 条件                 | verified値                                                                           |
| -------------------- | ------------------------------------------------------------------------------------ |
| Runtime / OS         | Node 24.19、Linux x64                                                                |
| Next.js / Playwright | Next 16.3.8 / Playwright 1.62.1                                                      |
| Browser              | Chromium 151.0.7922.34                                                               |
| Viewport / DPR       | 1280×720 / 1                                                                         |
| Refresh rate         | null（Playwright browser contextから取得できず）                                     |
| Server               | runner管理のNext `start`、`127.0.0.1:3001`                                           |
| Mock                 | app API routesをmock、primary route delay 50ms                                       |
| Real                 | 実route + runner所有の一時SQLite fixture。production/Tursoではない                   |
| Sample状態           | startup/deck navigationは別記録。主要操作はwarm。browser cacheはcold状態を保証しない |
| DB query count       | `null` / `not_instrumented`                                                          |

JSON自体にrun timestampはない。記録されたartifact mtimeはJST mock 06:59:07、real 07:00:39であり、実行時刻そのものとしては扱わない。

### 主要5操作のレイテンシ

以下はverified JSONの各値を`p50 / p95 ms`で示す。DOM値はDOM mutationから2回の`requestAnimationFrame`までのpaint proxyであり、paint/scan-out完了値ではない。4列目は「受理probe入力→対応する次POST開始 (proxy)」。内部lock解除時刻ではない。

**Mock（n=30/30、全行）**

| 操作              | 入力→POST start | POST start→response | 入力→DOM+2 rAF | 受理probe入力→対応する次POST開始 (proxy) |
| ----------------- | --------------: | ------------------: | -------------: | ---------------------------------------: |
| Keyboard advance  |      0.1 / 13.8 |         54.5 / 63.6 |    12.8 / 88.1 |                                0.1 / 0.9 |
| Keyboard previous |       0.1 / 0.4 |         54.7 / 62.6 |    13.6 / 18.9 |                                0.1 / 0.4 |
| Click advance     |       0.6 / 2.0 |         55.1 / 68.6 |    12.6 / 28.6 |                                0.1 / 0.3 |
| Swipe advance     |     79.9 / 94.7 |         56.1 / 67.1 |  110.7 / 120.2 |                                0.2 / 0.3 |
| Swipe previous    |     79.6 / 96.3 |         53.8 / 61.0 |  153.6 / 189.8 |                                0.1 / 0.4 |

**Real route + isolated SQLite（n=30/30、全行）**

| 操作              | 入力→POST start | POST start→response | 入力→DOM+2 rAF | 受理probe入力→対応する次POST開始 (proxy) |
| ----------------- | --------------: | ------------------: | -------------: | ---------------------------------------: |
| Keyboard advance  |       0.3 / 1.4 |         19.4 / 28.9 |    23.9 / 56.2 |                                0.2 / 0.3 |
| Keyboard previous |       0.2 / 0.3 |         18.9 / 28.3 |    11.0 / 20.3 |                                0.2 / 0.3 |
| Click advance     |       1.8 / 4.4 |         20.3 / 23.5 |    14.0 / 54.3 |                                0.2 / 0.4 |
| Swipe advance     |     79.4 / 89.4 |         19.8 / 26.5 |  123.3 / 148.1 |                                0.2 / 0.3 |
| Swipe previous    |     80.7 / 88.7 |         23.1 / 31.1 |  113.6 / 148.2 |                                0.2 / 0.3 |

Primary入力→次操作が受理されたPOST開始（p50 / p95 ms、n=30/30）も別proxyとして記録する。これは内部lock解除時刻ではない。

| Mode / 操作            | Primary入力→次受理操作POST開始 |
| ---------------------- | -----------------------------: |
| Mock keyboard advance  |                    64.7 / 78.2 |
| Mock keyboard previous |                    63.0 / 72.5 |
| Mock click advance     |                    64.2 / 85.1 |
| Mock swipe advance     |                  142.3 / 167.2 |
| Mock swipe previous    |                  139.3 / 169.0 |
| Real keyboard advance  |                    31.9 / 40.0 |
| Real keyboard previous |                    31.0 / 44.6 |
| Real click advance     |                    33.3 / 35.7 |
| Real swipe advance     |                  109.2 / 129.2 |
| Real swipe previous    |                  116.7 / 141.8 |

主要操作windowのrequest数（p50 / p95、各操作n=30/30）は、mock/realの双方でsession GET、controls GET、deck GETが5操作すべて0 / 0だった。これは操作window countであり、pollとの因果帰属を証明する値ではない。

| Mode / 操作            | Session GET count | Controls GET count | Deck GET count |
| ---------------------- | ----------------: | -----------------: | -------------: |
| Mock keyboard advance  |             0 / 0 |              0 / 0 |          0 / 0 |
| Mock keyboard previous |             0 / 0 |              0 / 0 |          0 / 0 |
| Mock click advance     |             0 / 0 |              0 / 0 |          0 / 0 |
| Mock swipe advance     |             0 / 0 |              0 / 0 |          0 / 0 |
| Mock swipe previous    |             0 / 0 |              0 / 0 |          0 / 0 |
| Real keyboard advance  |             0 / 0 |              0 / 0 |          0 / 0 |
| Real keyboard previous |             0 / 0 |              0 / 0 |          0 / 0 |
| Real click advance     |             0 / 0 |              0 / 0 |          0 / 0 |
| Real swipe advance     |             0 / 0 |              0 / 0 |          0 / 0 |
| Real swipe previous    |             0 / 0 |              0 / 0 |          0 / 0 |

### Swipe分解とscenario結果

Gesture start→releaseとrelease→DOM+2 rAFを分けた値（p50 / p95 ms、n=30/30）：

| Mode / 操作         | Gesture start→release | Release→DOM+2 rAF proxy |
| ------------------- | --------------------: | ----------------------: |
| Mock swipe advance  |           79.7 / 92.6 |             31.2 / 35.9 |
| Mock swipe previous |           79.5 / 94.8 |             77.9 / 98.7 |
| Real swipe advance  |           79.2 / 89.0 |             44.6 / 62.3 |
| Real swipe previous |           80.4 / 88.4 |             32.8 / 61.1 |

両modeのcore runはcomplete、主要5操作は各30/30で、run incompleteは0。共通のboundary previous-from-openingはHTTP 409でstate不変。追加のmock-only 7 scenario（start/end/rank boundary、empty deck、large/long deck、controlled slow overlap、controlled failure）はmockでcomplete、real runではすべてnot_applicableであり、実routeのscenario成功としては数えない。5入力burstはsynthetic入力5件、対応POST 1件、busy input proxy 4件を記録した。これは物理入力におけるlost inputの完全な測定ではない。Mockのcontrolled slow overlapはPOST応答まで1055ms、POST pending中のsynthetic controls GETが1件。別のcontrolled failureはHTTP 503でstate不変だった。

補足のcontrolled slow scenarioでは、1秒遅延中のsynthetic controls GETを1件観測し、POST response elapsedは1055msだった。これは意図的に重ねたGETであり、appのpoll cadenceを示さない。操作window内のGET件数一般にもperiodic pollとの重なりが含まれる可能性があり、request単位の因果帰属は不確実である。Mockの50ms固定遅延は処理内訳の証拠ではなく、実ネットワーク/production/Tursoへの外挿にも使わない。画像artifactは同一fixture質問のquestion/answer stateを撮影し、DOM headingとstateをassertするための参考資料である。画像はscan-out、実端末の視認時間、paint完了を証明しない。画面録画/traceによるframe単位の確認は実施していない。

### Phase / clauseごとの達成度

| 元計画の項目                               | 判定                   | 照合結果                                                                                                                                                                                      |
| ------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0.1 同一条件と設定記録               | 完了                   | commit、runtime/browser/device、viewport、DPR、server、DB/mode、mock delay、warm/cold区分を記録。refresh rateは未取得。                                                                       |
| Phase 0.2 mock/real分離                    | 完了                   | 別run/結果区分。realは実route+一時SQLiteでありproduction/Tursoではない。                                                                                                                      |
| Phase 0.3 n/p50/p95/欠測/outlier           | 完了                   | 主要5操作はmock/real各30/30。outlierを数え、除外はなし。                                                                                                                                      |
| Phase 0.4 主要入力/表示/gesture/視認       | 完了（proxy範囲）      | 5操作、DOM+2 rAF、swipe start→release/release→DOMを記録。artifactはDOM stateの参考で、視認/scan-outは未証明。                                                                                 |
| Phase 0.5 POST/次操作/busy入力             | 完了（proxy範囲）      | 入力→POST、POST→response、受理probe入力→対応POST start、primary入力→次に受理されたPOST startを別計測。busy probe/lost countはrunner出力に含む。どちらのPOST startも内部lock解除時刻ではない。 |
| Phase 0.6 boundary/slow/failure/burst/deck | 完了                   | boundary 409、start/end/empty/rank、large/long, 1 POST + 4 busy proxy burst、およびslow/failure scenarioを実施。                                                                              |
| Phase 0.7 60Hz p95目標                     | 未確定                 | refresh rateと対象実機が未確認。proxy値から正式SLOを確定しない。                                                                                                                              |
| Phase 0.8 GET/DB回帰基準                   | 一部完了               | request window別countはあるがGET poll因果は不確実。DB query countはnull/not instrumentedで未達。                                                                                              |
| Phase 0.9 原因による分岐                   | 判断完了               | input→POST待ち、DB query、render/fitが支配的と立証できるデータではない。runtime最適化の根拠にせず、runtime phaseに進まない。                                                                  |
| Phase 1 確定状態での即時表示               | 未着手                 | runtime変更なし。poll/mutation境界変更を採用しない。                                                                                                                                          |
| Phase 1b 描画短縮                          | 未着手                 | 2 rAF proxyとscreenshotだけではrender/fit支配を立証できず、trace根拠なし。                                                                                                                    |
| Phase 2 待機入力queue                      | 未着手・別意思決定なし | R7 single-flight中の入力無視を継続。queue導入の仕様判断/変更は行っていない。                                                                                                                  |
| Phase 3 DB処理                             | 未着手                 | query countが未計測で、DB支配の立証なし。既存controls-only経路を再提案しない。                                                                                                                |
| 実装順 1（Phase 0報告）                    | 完了                   | 本節に比較条件、分離結果、p50/p95/n、scenario、制約とphase判断を記録。                                                                                                                        |
| 実装順 2–8（runtime変更と検証）            | 未着手                 | runtime phaseを選定していないため、UI/API/DB変更、テスト追加、runtime検証gateは実施していない。                                                                                               |
| 完了条件（性能改善前後比較）               | 未達/適用外            | before/after runtime candidateがなく、改善を主張しない。Phase 0の測定成果のみ完了。                                                                                                           |

### テクニカルキーポイント照合

| 計画のキーポイント | 判定                            | 根拠/制限                                                                                                                 |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 入力から画面表示   | 計測完了（代理指標）            | DOM+2 rAFとswipe分解値を採取。paint完了とscan-outは未計測。                                                               |
| pollとの競合       | 未立証・変更なし                | core operation GET windowは0/0。synthetic slow GET 1件は意図的重複であり、poll起因性・送信前poll waitの支配を証明しない。 |
| 送信順             | 維持                            | runtime POST直列性、snapshot/revision、CAS/409処理の変更なし。                                                            |
| optimistic表示     | 維持・今回再検証対象外          | runtime表示経路の変更なし。性能を理由に推測表示を追加していない。                                                         |
| 状態保持とロック   | proxy計測、直接lock時刻は未測定 | second input timestamp→対応POST start proxyを記録。内部unlock時刻は断定しない。                                           |
| 描画とfit          | 原因未立証・変更なし            | DOM+2 rAFとDOM state artifactのみ。trace、fit所要時間、全stage/viewport保証の再検証なし。                                 |
| API/DB             | 制約確認、query内訳は未測定     | real routesは一時SQLiteで完了。production/Tursoではなく、DB query countはnull/not instrumented。runtime API/DBは無変更。  |

### 追記前のverified runner時点の判断（履歴）

以下のruntime未採用判断と技術キーポイント記録は、verified runnerで測定した時点の歴史的スナップショットであり、追記後の現行実装を説明するものではない。

今回の結果から、input→POST wait、DB処理、React/render/fitのどれが改善対象として支配的か立証できない。mockの固定delayは原因帰属に使えず、real runもlocal SQLiteでproduction/Turso測定ではない。したがってPhase 1、1b、3は採用せず、runtime変更を行わない。Phase 2は別仕様意思決定がなく、R7 single-flight契約を維持する。burstの4件はsynthetic busy-input proxyとして報告し、queue需要/仕様変更の証拠とはしない。

R7/R8/API/DBのruntime実装を変更していない。直列POST、snapshot/revision整合、rollback/reconcile、401時private state消去、mutation no-retry、5 controls validation、fit/readabilityの各実装は今回の差分対象外であり、これらを性能のために緩和していない。API契約、データモデル、アーキテクチャの変更がないため、`openspec/specs/stcirt/spec.md`の更新は不要と判断した。計測runnerとこの計画報告のみの変更であり、runtime tests/benchmarkはこの文書編集では実行していない。

### 2026-10-17 追記: 最新位置の集約実装

ユーザー承認により、presenterの位置永続化にlatest-wins方式を実装した。操作中のローカルなスライド移動は継続でき、単一の背景writerが未送信の絶対位置を最新targetへ集約して直列送信する。位置POSTには `expectedSnapshotRevision` と `expectedSessionVersion` を必須とする。曖昧な失敗では同一envelope/operation IDで再試行し、409後はcontrols/deckを再同期して、同じrevision内で有効な最新targetを新しいoperation IDで再送する。revisionが変われば古いdeckのtargetを破棄してサーバー位置を採用する。終端位置は `max(questionCount - 1, 0)` に正規化し、teardown時にqueueとretry timerを消去する。coalesceされた未送信targetはoperation ledgerに記録しない。従来の `start`、`advance`、`previous` 等のadmin API操作は既存用途のため維持する。これらの契約をR7とPresentation API節に同期した。

この実装により、本書の「Phase 2未着手」「R7の入力無視を維持」「runtime変更なし」という2026-10-17時点の判断は現行コードには適用されず、歴史的な計画・計画時点の記録として残る。計画内のverified runner値、ベースライン数値、source fingerprint SHA-256 `24b39b87286a1bf5512aabbe42d8003a563555d754b2123ea6e4215dc5f854c8` およびcommit `02ef03ab00a5e4d973802a89b4db6ea6f8e980fc` は変更していない。これらはfingerprint対象時点のコードに対する結果であり、今回の実装の性能を測定していない。本追記は性能改善幅、新しい性能値、全計画の完了を主張しない。

### 2026-10-17 追記: commit後検証結果とcoverage未達

runtime差分はユーザー確認のうえ commit `2e3fc63` としてコミット済み。続く `.verify/verify-71.txt` 付きの commit `527e6a1` にOrchestrator検証記録を残した。結果は次のとおり。

| ゲート                 | 結果                                               |
| ---------------------- | -------------------------------------------------- |
| `pnpm lint:fast`       | PASS（warning 7件は既存でありPlan 71差分と無関係） |
| `pnpm type-check:fast` | PASS                                               |
| `pnpm test`            | PASS（65 files / 1081 tests）                      |
| `pnpm test:coverage`   | **FAIL**（coverage 100%閾値に対して2ファイル未達） |

coverage FAIL の未達対象と未カバー箇所は次のとおりであり、これらのテスト追加は後続タスクとして扱い、本計画を完結扱いにしない。

- `src/app/presentation/presentation-screen.tsx`: stmts 96.47% 等多重未達。未カバー行 1057 / 1061 / 1068 / 1232 付近。presenter-position 導入に伴う `rangesStr.length === 0`・`rangesMap.size === 0` などの新規ガード分岐および既存蹟。
- `src/lib/db/repository/presentation-repository.mutations.ts`: stmts 99.7%。未カバー行 575 の分岐片側。

したがって本計画の状態は「Phase 0 verified run完了・runtime改善未採用」から「latest-wins位置永続化実装済み・coverage検証未達により未完了」とする。改善幅の性能主張は従来どおり行わない。残タスクは、上記coverage未達3ヶ所のテスト追加と、必要な場合のmiddleware修正を経たgate再実行である。
