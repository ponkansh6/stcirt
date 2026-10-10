# shared-plan40 性能ベースライン

## 状態と読み方

この文書では、Phase 0としてadmin、presenter、public projection、participant answer、completion、resultsの6領域について、ソースから分かる動作を基にした限定的なベースラインを記録する。この6領域のHTTP/SQL概算は静的推定であり、性能実測値はない。これとは別に、public projectionの8ケースだけを対象として、修復済みの同一benchmark sourceを使い、変更前のarchived HEADと変更後のworktreeを同じ隔離fixture・条件で各40 samples比較したローカル実測を記録する。計測はfile-backed libSQL/SQLite fixture内のrepository callまたはin-process route handlerとDrizzle statement loggerに限られ、wire HTTP、ブラウザー、remote DB、DB network roundtripの性能計測ではない。数値は次の区分で扱う。

- **ローカル実測**: public projection 8ケースについて、Phase 2の隔離fixtureで同じbenchmark sourceを使い、archived HEADと変更後worktreeから収集した値。ブラウザー/wireやproduction環境の性能値ではない。
- **静的推定**: ソースから推定したpoll間隔やDrizzle呼び出し数。実際の実行時間、DB statement、roundtrip数ではない。
- **未計測**: 適切な計測がなく、値を提示できない項目。

利用者名、回答本文、cookie、PIN、secret、request/response body は記録しない。

## 実行条件

| 項目                                      | Phase 0 静的確認                       | Phase 2 local benchmark                                                                 |
| ----------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| 対象                                      | 作業ツリーのソース                     | 同一の修復済みbenchmark sourceを変更前 `HEAD` archiveと変更後worktreeで実行             |
| DB                                        | 起動していない                         | 隔離されたfile-backed libSQL/SQLite test fixture。`.env` / production DB不使用          |
| 計測範囲                                  | source-derived request/query estimates | `getPublicPresentation` repository callまたはin-process `/api/presentation` GET handler |
| サンプル数                                | 該当なし                               | 各case 40 samples                                                                       |
| ブラウザー / wire HTTP                    | 未使用                                 | 未使用。route handler値はブラウザー/wire HTTPを含まない                                 |
| SQL count                                 | 静的Drizzle SELECT call推定のみ        | aggregate Drizzle statement logger calls。DB network roundtripsではない                 |
| throughput / CPU / memory / remote DB負荷 | 未計測                                 | 未計測                                                                                  |

## Phase 0 領域別静的ベースライン

「概算SQL」はソース上の Drizzle select 呼び出し数であり、DBで観測したstatement数ではない。認証照会、transaction内の実行、ドライバーによる処理時間、キャッシュ、失敗/再試行を含む実測値とは異なる。

| 領域               | ソースから分かる動作                                                                                                                             | 静的なリクエスト/SQL概算                                                                                                                                          | 実測値                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| admin              | `src/app/admin/presentation/presentation-admin.tsx` が初回と2.5秒ごとに更新。認証済みの場合、session GET と管理状態 GET を行う。                 | 認証済みpoll 2 HTTP GET / 2.5秒。既存sessionで管理状態GETは最大4 select（session、questions、entries、result settings）。sessionなしの場合は2 select。            | latency、実SQL数とも未計測                        |
| presenter          | presenter mode は2.5秒ごとに session GET、controls GET。deck は初回または snapshot revision の変化時に取得し、操作はPOSTで送る。                 | 通常poll 2 HTTP GET / 2.5秒。controls GET 1 select。deck取得時は admin state の読み取りと source question の読み取りを含み、snapshot内容によって概ね4〜5 select。 | poll/操作 latency、実SQL数とも未計測              |
| public projection  | public view は `/api/presentation` を1.4秒間隔でpollする。hiddenでなければ投影状態を組み立てる。                                                 | 1 HTTP GET / 1.4秒。既存sessionでは hidden確認と管理snapshotの読み取りを合わせ概ね5 select、answer/順位発表状態では source questions の1 selectが加わる。         | poll/response latency、実SQL数とも未計測          |
| participant answer | 回答送信は `/api/answers/batch` POST。通常の回答画面に定期pollはない。復元/再確認では submission GET 等を使う。                                  | 一括送信ごとに1 HTTP POST。参加者session照会と保存処理内のSQL数・所要時間は未計測。送信頻度は利用者操作依存。                                                     | submit latency、SQL数、処理量とも未計測           |
| completion         | 回答完了状態で `/api/participants/results` を初回に取得し、タブが再表示された時にも取得する。周期pollはない。                                    | 初回/可視化ごとに1 HTTP GET。参加者照会1 selectに加え、結果非公開時はsettings 1 select、公開済みならsettings・entry・questionsの最大3 select。                    | 完了から結果状態反映までの時間、実SQL数とも未計測 |
| results            | `src/app/results/page.tsx` が初期表示時に結果を読む。クライアント側はタブが再表示された時に `/api/participants/results` を読む。周期pollはない。 | SSR初回は参加者照会1 select + 結果照会（非公開時1、公開済みで最大3 select）。可視化後のGETもcompletionと同様。                                                    | page/API latency、実SQL数とも未計測               |

SQL概算は `src/lib/db/repository/presentation-repository.ts` の `readAdminPresentation`、`readAdminPresentationControls`、`getPublicPresentation`、`getParticipantResult` の分岐を読んだ推定である。poll intervalはコンポーネント内の timer 定義に基づく。ネットワークの揺れ、画面の開閉、認証状態、DBのデータ有無で実際の回数は変わる。

## 条件別の計測範囲と状態

以下の表では、HTTP count/cadence はページ/操作ごとの HTTP request 数と発生間隔、response time はクライアントが開始から応答を受け取るまでの時間、DB statements はサーバーが実行したSQL statement数、DB roundtrips はDBとの往復回数を指す。このPhase 0 matrixはソース上の挙動と静的推定を記録し、response time、実行されたDB statements、roundtripsは未計測である。Phase 2の隔離fixtureによるroute-handler latencyとstatement logger countは後段の独立した測定表に記載する。

### admin

| 条件                                             | HTTP count / cadence                                                                                                           | response time | DB statements / roundtrips                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------- |
| 通常（認証済み、表示中）                         | **推定**: 初回にsession GETと状態GET。以降2 GET / 2.5秒。                                                                      | **未計測**    | **未計測**。状態GETは既存session時に4 Drizzle SELECT callと推定。roundtrip数は不明。                        |
| refresh cycleのrequest-response latencyが2.5秒超 | **未計測**。ソース上はin-flightを止めるガードがなく、interval tickごとに更新を開始する。HTTP数とcadenceの実値は不明。          | **未計測**    | **未計測**。状態GETあたり最大4 Drizzle SELECT callの静的推定は通常時と同じ。実statement/roundtrip数は不明。 |
| hidden（タブ非表示）                             | **未計測**。visibilityによる停止処理は見当たらず、2.5秒 interval は登録されたまま。ブラウザーによるthrottle後のcadenceは不明。 | **未計測**    | **未計測**。実statement/roundtrip数は不明。                                                                 |
| unauthenticated                                  | **推定**: 初回と2.5秒ごとにsession GET 1件のみ。認証されないため状態GETへ進まない。                                            | **未計測**    | **未計測**。アプリDBの状態照会はなし。session endpoint内の認証処理のDB利用有無/往復数は未確認。             |
| public projection/stage                          | N/A（admin consoleの条件ではない）                                                                                             | N/A           | N/A                                                                                                         |

### presenter

| 条件                                             | HTTP count / cadence                                                                                              | response time | DB statements / roundtrips                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| 通常（認証済み、deck revision一致）              | **推定**: session GET + controls GET、2 HTTP GET / 2.5秒。actionごとに1 POST。                                    | **未計測**    | **未計測**。controls GETは1 Drizzle SELECT callの推定。DB roundtrip数は不明。          |
| refresh cycleのrequest-response latencyが2.5秒超 | **未計測**。interval callbackは前回refreshを待たず、同じ周期のrefreshが重なることがある。実HTTP数/cadenceは不明。 | **未計測**    | **未計測**。実statement/roundtrip数は不明。                                            |
| hidden（投影非表示）                             | **推定**: presenter console自体はsession/controlsをpollし続ける。controlsがhidden状態を返す。2 GET / 2.5秒。      | **未計測**    | **未計測**。controlsは1 Drizzle SELECT callの推定。roundtrip数は不明。                 |
| unauthenticated                                  | **推定**: session GET 1件 / 2.5秒。session確認に失敗するとcontrols/deckは取得しない。                             | **未計測**    | **未計測**。controls/deckのSELECTはなし。session endpointのDB利用有無/往復数は未確認。 |
| public projection/stage                          | N/A（presenter consoleはadmin操作用。表示stageに対応した投影データはcached deckから選ぶ）                         | N/A           | N/A                                                                                    |

### public projection

| 条件                                              | HTTP count / cadence                                                                                                                                             | response time               | DB statements / roundtrips                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 通常（非hidden、not_started等）                   | **推定**: `/api/presentation` GET 1件 / 1.4秒。                                                                                                                  | **未計測**                  | **未計測**。既存sessionで約5 Drizzle SELECT callの静的推定（hidden確認 + admin snapshot）。roundtrip数は不明。  |
| projection GETのrequest-response latencyが2.5秒超 | **未計測**。>2.5秒はprojection GETのrequest-response latencyを指す。設定上のintervalは1.4秒。遅い応答時の実開始cadenceとrequest overlapは未計測。                | **未計測**                  | **未計測**。実statement/roundtrip数は不明。                                                                     |
| hidden（projectionHidden=true）                   | **推定**: GET 1件 / 1.4秒。serverはhidden確認後にstandbyを返し、admin snapshotの読み取りへ進まない。                                                             | **未計測**                  | **未計測**。hidden確認1 Drizzle SELECT callの推定。DB roundtrip数は不明。                                       |
| unauthenticated                                   | **推定**: public endpointなので認証なしでもGET 1件 / 1.4秒。                                                                                                     | **未計測**                  | **未計測**。認証照会なし。非hidden時はstage依存のSELECTがある。                                                 |
| public projection/stage                           | **推定**: question/not_started等は上記GET。answerまたはthird/second/firstでは同じpollにsource question GETが加わるわけではなく、server側の追加SELECTが行われる。 | **未計測**（stage別未計測） | **未計測**。answer/rank stageではsource questionsの1 Drizzle SELECT callを追加と推定。実SQL/roundtrip数は不明。 |

### participant answer

| 条件                                          | HTTP count / cadence                                                                                                   | response time | DB statements / roundtrips                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------- |
| 通常（回答送信）                              | **推定**: 一括回答送信操作1回につきbatch POST 1件。定期pollなし。                                                      | **未計測**    | **未計測**。route上で参加者照会と保存処理を呼ぶ。保存処理の実statement/roundtrip数は未集計。 |
| batch POSTのrequest-response latencyが2.5秒超 | **未計測**。自動periodic retryは確認できない。ユーザーの再送有無を含むHTTP数は未計測。                                 | **未計測**    | **未計測**。実statement/roundtrip数は不明。                                                  |
| hidden（タブ非表示）                          | **未計測**。回答画面のvisibility handlerはなく、定期pollもない。ユーザー送信中のHTTP継続状況は未計測。                 | **未計測**    | **未計測**。実statement/roundtrip数は不明。                                                  |
| unauthenticated                               | **推定**: submission APIへの要求があれば1 HTTP requestで401。無効なsession tokenの場合participant DB照会前に終了する。 | **未計測**    | **未計測**。無効tokenではparticipant照会なし。session検証/DB往復の実測なし。                 |
| public projection/stage                       | N/A（回答送信はprojection stageに依存しない）                                                                          | N/A           | N/A                                                                                          |

### completion

| 条件                                           | HTTP count / cadence                                                                                                                    | response time | DB statements / roundtrips                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| 通常（回答完了画面へ入る）                     | **推定**: `/api/participants/results` GET 1件を即時実行。定期pollなし。                                                                 | **未計測**    | **未計測**。participant照会1 + 非公開時1 / 公開時最大3 Drizzle SELECT callの推定。roundtrip数は不明。 |
| results GETのrequest-response latencyが2.5秒超 | **未計測**。interval/retryはなく、完了画面の次の自動要求はvisible event時。実HTTP数は未計測。                                           | **未計測**    | **未計測**。実statement/roundtrip数は不明。                                                           |
| hidden（タブ非表示）                           | **推定**: hidden中は新規要求なし。visibleへ戻った時にGET 1件を要求する。in-flight要求との重複はqueueされ、完了後に追加refreshされ得る。 | **未計測**    | **未計測**。実statement/roundtrip数は不明。                                                           |
| unauthenticated                                | **推定**: 要求時に1 HTTP GETで401。無効なsession tokenならparticipant照会前に終了する。                                                 | **未計測**    | **未計測**。無効tokenではparticipant照会なし。session検証/DB往復の実測なし。                          |
| public projection/stage                        | N/A（participant resultsの公開状態を参照し、projection stageは条件にしない）                                                            | N/A           | N/A                                                                                                   |

### results

| 条件                                           | HTTP count / cadence                                                                                                           | response time                                  | DB statements / roundtrips                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 通常（results page初期表示）                   | **推定**: SSRでページを生成。結果APIへの初回client fetchや定期pollはなく、visible event時にGET 1件。                           | **未計測**（SSR page time/API timeとも未計測） | **未計測**。SSRはparticipant照会1 + 非公開時1 / 公開時最大3 Drizzle SELECT callの推定。roundtrip数は不明。 |
| results GETのrequest-response latencyが2.5秒超 | **未計測**。定期pollなし。visibility eventに起因するrequestの完了が遅い場合の挙動/HTTP数は未計測。                             | **未計測**                                     | **未計測**。実statement/roundtrip数は不明。                                                                |
| hidden（タブ非表示）                           | **推定**: hidden中の新規要求なし。visibleへ戻るeventでGET 1件を要求する。                                                      | **未計測**                                     | **未計測**。実statement/roundtrip数は不明。                                                                |
| unauthenticated                                | **推定**: SSRではparticipant確認失敗時にunauthenticated表示。clientは後続のvisibility eventで結果GETを行った場合、1 HTTP 401。 | **未計測**                                     | **未計測**。無効tokenではparticipant照会なし。session検証/DB往復の実測なし。                               |
| public projection/stage                        | N/A（participant resultsは公開設定を参照し、projection stageを参照しない）                                                     | N/A                                            | N/A                                                                                                        |

## Phase 2 後の静的比較

以下はPhase 2前の `HEAD` ソースと現在の作業ツリー、ならびに現在のテスト期待値から整理した静的比較である。HTTP cadenceとDrizzle SELECT call数の推定/テスト確認であり、ブラウザーの実request、wire latency、DB roundtripの計測ではない。route-handler local latencyは後段の実測表に記載する。**この静的比較だけで性能改善を実測したものではない。**

### admin / presenter のHTTP cadence

| 条件                            | admin: Phase 2前 → 後                                                                                                                                                                                                        | presenter: Phase 2前 → 後                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 通常（認証済み、visible）       | Phase 2前: 2.5秒 `setInterval`。各pollでsession GET + admin state GET、応答が周期より遅い場合も重複し得る。後: 初回/visible復帰時にsession GET + state GET、その後はrefresh完了から2.5秒後にstate GETのみ。refreshを直列化。 | Phase 2前: 2.5秒 `setInterval`。各pollでsession GET + controls GET、必要時にdeck GET。後: 初回/visible復帰時にsession GET + controls GET、その後はrefresh完了から2.5秒後にcontrols GETのみ。deckは初回/revision不一致時。refreshを直列化。 |
| request-response latency >2.5秒 | Phase 2前: poll重複が可能、timeoutなし。後: 一度に一つのrefreshを処理し、8秒timeout後に次のpollをscheduleする実装。実HTTP数、latency、timeout発生率は未計測。                                                                | Phase 2前: poll重複が可能、timeoutなし。後: 一度に一つのrefreshを処理し、8秒timeout後に次のpollをscheduleする実装。実HTTP数、latency、timeout発生率は未計測。                                                                              |
| unauthenticated                 | Phase 2前: session GETを2.5秒ごとに繰り返し、state GETへ進まない。後: 初回/visible復帰時にsession GETし、未認証ならpollをscheduleしない。                                                                                    | Phase 2前: session GETを2.5秒ごとに繰り返し、controls/deck GETへ進まない。後: 初回/visible復帰時にsession GETし、未認証ならpollをscheduleしない。                                                                                          |
| hidden → visible                | Phase 2前: visibilityによるpoll停止なし。2.5秒周期pollは登録されたまま（実ブラウザーのbackground throttlingは不明）。後: hiddenでtimerを止め、visible復帰時にsessionを再確認して状態を読む。hidden中の実HTTP数は未計測。     | Phase 2前: visibilityによるpoll停止なし。2.5秒周期pollは登録されたまま（実ブラウザーのbackground throttlingは不明）。後: hiddenでtimerを止め、visible復帰時にsessionを再確認してcontrolsを読む。hidden中の実HTTP数は未計測。               |

### public projection のstage別 Drizzle SELECT call数

比較条件は既存sessionがありprojectionがvisibleである場合。数は順に `presentationQuestions / presentationEntries / examQuestions` のDrizzle SELECT call。Phase 2前は変更前ソースからの推定、Phase 2後は現行 `tests/db/presentation-repository.test.ts` のstage count assertionsおよびQ5/non-Q5 response testsとソースに基づく。括弧内totalはsource-inferred SELECT call数で、DBで実行されたstatement/roundtrip数ではない。

| 条件 / stage                             |                                 Phase 2前（ソース推定） |                           Phase 2後（テスト/ソース推定） |
| ---------------------------------------- | ------------------------------------------------------: | -------------------------------------------------------: |
| visible question（Q5以外）               | `1 / 1 / 0`（total 5: hidden/session/settings等を含む） | `1 / 0 / 0`（total 2: stage session + current question） |
| answer（通常の選択式、Q5以外）           |                                  `1 / 1 / 1`（total 6） |                                   `1 / 0 / 1`（total 3） |
| answer（回答表示対象の自由記述、Q5以外） |                                  `1 / 1 / 1`（total 6） |                  `1 / 1 / 1`（total 4。回答entryを読む） |
| answer（識別済みQ5の自由記述）           |                                  `1 / 1 / 1`（total 6） |            `1 / 0 / 1`（total 3。Q5回答entryは読まない） |
| podium preview                           |                                  `1 / 1 / 0`（total 5） |                `0 / 0 / 0`（total 1: stage sessionのみ） |
| rank stage（third / second / first）     |                                  `1 / 1 / 1`（total 6） |                                   `1 / 1 / 1`（total 4） |
| hidden（stageによらず）                  |           `0 / 0 / 0`（total 1: hidden確認sessionのみ） |         `0 / 0 / 0`（total 1: stage/hidden sessionのみ） |

public projection はpresenter専用pollとは別に1.4秒設定のbackground pollingを継続する。現行 regression test はdocumentがhiddenでもpublic projection pollingが継続することを確認している。この値もsource/test上の挙動であり、実ブラウザーのcadenceやrequest数は未計測。slow response時の実開始cadence/overlapも未計測である。

## Phase 2 public projection ローカル実測

変更前 `HEAD` archiveと変更後worktreeに、同一の修復済みbenchmark sourceを使い、隔離されたfile-backed libSQL/SQLite test fixtureで同じ条件を計測した。各case 40 samples。計時対象は `getPublicPresentation` repository call、またはin-process `/api/presentation` GET handlerである。以下の時間はroute-handler計測値で、ブラウザー、wire HTTP、network、remote DBを含まない。SQL数はaggregate Drizzle statement logger callsであり、DB network roundtrip数ではない。production DBや`.env`は使用していない。

各p50/p95はミリ秒。statement数は1リクエストの合計Drizzle statement logger callsである。

| projection条件          | statement calls 前 → 後 | in-process route handler p50 / p95 ms 前 → 後 |
| ----------------------- | ----------------------: | --------------------------------------------: |
| hidden                  |                   1 → 1 |             0.3993 / 0.5612 → 0.4285 / 0.6655 |
| question                |                   5 → 2 |             1.0545 / 1.4889 → 0.5650 / 0.6056 |
| selected answer         |                   6 → 3 |             1.1274 / 1.1938 → 0.6728 / 0.7491 |
| Q5 free-text answer     |                   6 → 3 |             1.2002 / 1.6182 → 0.6770 / 0.9647 |
| non-Q5 free-text answer |                   6 → 4 |             1.1473 / 1.2360 → 0.8228 / 0.9322 |
| podium preview          |                   5 → 1 |             0.9896 / 1.2828 → 0.3910 / 0.4629 |
| finished                |                   5 → 1 |             1.0167 / 1.0727 → 0.3883 / 0.4269 |
| rank stage              |                   6 → 4 |             1.1580 / 1.2959 → 0.8797 / 0.9817 |

Hiddenのroute-handler latencyはこのfixtureではわずかに上昇し、全caseで一様な短縮ではない。public projectionはhidden tabでもbackground pollingを続ける。設定interval 1.4秒と全stage中最大の測定route-handler p95 0.9817msを足したfixture内の参考 freshness budgetは約1.4009817秒（約1.401秒）。これはブラウザー/wire/networkを除外したfixture上の計算であり、本番保証ではない。ページ再表示時にadmin/presenterは即時refreshするが、visibility eventから画面描画までのend-to-end時間は未計測。admin/presenter route latencyも未計測である。

wire HTTP latencyとremote database roundtripsの計測は別途必要であり、このローカル実測値には含まれない。

## 以前の測定結果（歴史的参考）

[`presentation-plan35.md`](presentation-plan35.md) は shared-plan35 時点の発表操作に関する別計測である。localhost の webpack dev server、Chromium、HTTP mock delay 50ms、browser操作10回、DB fixture操作40回などの条件で得た値を記載している。現在の shared-plan40 の値ではなく、対象6領域すべてを測定したものでもない。shared-plan40 の比較ベースラインとして転用しないこと。

同レポートにある presentation 操作 latency、cold load、local fixture上のDB値は歴史的参考値に限る。条件や実装が揃った比較なしに改善/劣化を結論づけない。

## 再現可能な安全な計測手順

1. 同一のコードrevision、Node.js/pnpm、依存関係、ローカルDB fixture、ブラウザー、マシン条件を比較対象間で揃え、revisionと環境情報を記録する。
2. 開発用ローカル環境だけを使い、実在する参加者データや本番接続情報を使わない。合成fixtureと無害な仮データを用意する。PIN/secretは環境変数で渡し、記録や出力に含めない。
3. 6領域それぞれについて、測る操作、開始/終了イベント、warm/cold条件、試行回数を事前に固定する。request body、cookie、回答文字列、表示名を保存せず、URL path、HTTP method、status、duration、相関用のランダムIDだけを集計する。
4. ブラウザー計測では主要操作を複数回繰り返し、個々の値と p50/p95、サンプル数を記録する。ページ更新後の時間はDOM更新など proxy の定義を明記し、描画完了と誤認しない。
5. DB計測ではローカルfixture上でDrizzle/SQLite statement数と処理時間を集計し、集計範囲、warm-up、試行回数を記録する。本番DBの性能値として扱わない。
6. 生ログではなく匿名化した集計値だけをこの文書へ転記し、失敗、未計測項目、環境差を併記する。

既存の `scripts/measure-presentation-latency.mjs` は発表操作のブラウザー計測用であり、上記6領域全体の計測器ではない。実行例とそのproxy/制約は [`presentation-plan35.md`](presentation-plan35.md) にある。新しい数値を得る場合は、対応領域の計測器/手順と実行結果を分けて記録する。
