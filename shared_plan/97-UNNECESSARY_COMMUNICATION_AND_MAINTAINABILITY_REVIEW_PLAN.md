# 不要な通信と保守性の見直し計画

## 状態

- 作成日: 2026-10-25
- 状態: 実装・計画照合・検証完了。P1を実装し、P2は操作後GETを現状維持と判断した。
- 実装状況: P1 mapperと2 callerを実装し、内部フィールド非露出の契約テストfixtureを強化。P2は削減条件を確認できないためGETを維持。API/Requirements契約は不変で仕様書変更なし。
- 保存場所: `shared_plan/` は既定で`.gitignore`対象。他の共有計画は除外したまま、今回のユーザー指示に従って本書だけを`.gitignore`の例外に追加し、Git追跡対象にした。
- 調査時点: 開始時の作業ツリーはclean、HEADは `c1147fb`。以降の変更状態は実装開始前に確認する。
- 調査範囲: 結果画面のSSR/API、共有結果、プレゼンテーション管理・公開画面の取得経路と関連repository readsを読んだ。全コード、本番トラフィック、実データの網羅調査ではない。
- 結論: SSRとprivate results APIの重複DTO変換を専用allowlist mapperに集約した。管理操作後GETは、POSTの6 control fieldsだけではGETのvisible/ready契約を満たさず、DB性能を比較できる計測器もないため維持した。削減効果は主張しない。
- ユーザーへの必須確認事項: なし。

## 目的

1. 結果画面の初期表示と更新APIで重複する結果DTO変換を一か所に集め、両方の応答形状がずれる保守負担を減らす。
2. 管理操作後の状態GETを減らせるか、操作別の応答契約・DB読み取り・鮮度要件を根拠に判断する。
3. 必要な認証、表示鮮度、古い応答の排除、公開境界を保ち、通信削減が複雑性や全体負荷を増やす場合は現状を維持する。

## 確認済みの現状

### 結果DTO変換

- `src/app/results/page.tsx:77-102` と `src/app/api/participants/results/route.ts:26-55` は、`getParticipantResult` のvisible結果を表示用 `ParticipantResult` へ個別に変換している。
- どちらも `rank`、`isAggregationTarget`、`participantCount`、`score`、`maxScore`、質問ごとの `position` / `question` / `answer` を投影する。
- answerは `selected` の `value` / `correctness`、`freeText` の `value` / `score`、その他は `kind` のみを返す。初期表示とAPI更新でこの分岐も重複している。
- 表示型とpayload parserは `src/lib/participant-results-contract.ts` にある。repository側には別の結果型があり、共通mapperは見つかっていない。
- SSR/APIの境界は異なる認証・scope・応答処理を行う。変換だけを共有し、取得や認可まで一つの汎用helperへ寄せない。

### 管理画面の操作後取得

- `src/app/admin/presentation/presentation-admin.tsx:103-151` の `postAction()` は、start/reset成功時にPOST bodyを利用せず、aggregate成功時も `aggregationSummary` を取り出す。
- 同ファイル `:424-447` の `runAction()` はstart/reset/aggregateの成功後にstate GETを行う。
- `src/app/api/admin/presentation/route.ts:127-137` のPOST応答は、`state`、`version`、`snapshotRevision`、`questionIndex`、`questionCount`、`projectionHidden` と、条件により `aggregationSummary` を含む。
- mutation repositoryは同じtransaction内で管理操作後のcontrolsを読んで応答する。一方、通常のGETはそれに加えて `participantResultsVisible` と `participantResultsReady` も含む。POSTとGETは同じDTOではない。
- resetやaggregate等が結果のready状態に与える影響をactionごとに確認する必要がある。古いUI値で補完してGETを消せるとはまだ言えない。
- 管理画面は操作中のpollを止め、single-flight・応答sequence・timeout/abortで競合を抑制している。既存テスト `tests/app/admin/presentation-admin.test.tsx` の「keeps polling paused while an administrator action is pending」は操作中の順序を検証する。

### 正常な鮮度取得

- 公開projectionは約1.4秒、管理画面は約2.5秒のpollを行う。公開側は応答後に次の取得を予約し、双方とも停止・abort等を備える。
- これらのpollは表示状態や集計結果の鮮度に関わる。現状の証拠から不要と判断せず、間隔変更やpush配信への置き換えを今回提案しない。
- `/results` のSSR取得は初期HTML用、クライアントAPIは後の手動更新・タブ復帰時用であり、同時の重複送信とは確認できない。
- repositoryへのDB読み取りはNext.jsのHTTP `fetch` cacheとは別の経路であり、fetchキャッシュ設定だけでDB queryが減るとはみなさない。

## 未確定事項

| 論点 | 確認内容と判断基準 |
| --- | --- |
| 管理POST後GETを省けるaction | action別にPOST/GETの全フィールド、mutation後に変わり得るvisible/ready、失敗時再同期を対応づける。全フィールドを正しく保てる場合だけ削減候補にする。 |
| 通信削減の実効性 | 操作あたりのHTTP要求数に加えてDB読み取り数、transactionの待ち時間、poll再開後の読み取りを計測する。計測手順と比較条件を先に定め、効果は実測後に記録する。 |
| DTO mapperの配置 | 表示型/parserとrepository結果型の依存方向を保てる専用moduleを選ぶ。型の全面移動やrepositoryのruntime importは避ける。 |

## 対象外と既存計画との境界

- 投影・管理画面のpoll頻度変更、SSE/WebSocket化、全体キャッシュ導入、汎用fetch hook化は今回の対象外。必要が生じた場合は鮮度要件と計測を伴う別計画にする。
- `shared-results` のfetchはparticipant resultsの認証・cookie・404・失効・abort契約が異なる。共通化を目的に同じhook/APIエラー処理へ寄せない。
- Plan 65で完了した管理画面の起動・表示復帰時の取得改善は再実装しない。Plan 77の保守性改善は完了済み。Plan 80の包括的評価へ無条件に項目を重ねない。
- Plan 95の共有結果境界とPlan 96の個人結果要件を維持する。氏名を共通 `ParticipantResult`、parser、共有結果に追加しない。今回のDTO mapperはそれらに含まれていない限定候補である。

## 推奨方針

### P1 — 表示DTO mapperを共有

1. `src/lib/participant-results-contract.ts` の近くに、結果から表示契約への専用pure mapperを追加する。候補名は `src/lib/participant-result-projection.ts`。
2. repositoryの結果型は `import type` でのみ参照し、戻り値は表示用 `ParticipantResult` とする。parser/表示契約にDB実装のruntime依存を持ち込まず、型を一斉移動しない。
3. visible結果の公開フィールドを列挙し、answer variantを現在の規則どおりに写す。object spreadやrepository結果の丸返しは使わず、内部フィールドが後日追加されても応答へ漏れないようにする。
4. SSR pageとprivate results routeの2箇所からmapperを呼ぶ。認証、代理scope解決、DB取得、HTTP status、`no-store` headerはそれぞれの境界に残す。
5. 非visible結果の形状も現行契約を維持する。共有結果経路や個人氏名表示要件は変更しない。

### P2 — 管理POST後GETの計測と採否

1. start/reset/aggregateごとに、mutation後に変わり得る管理UI state全項目と、その値の取得元を表にする。`participantResultsVisible` / `participantResultsReady` の更新条件を特に確認する。
2. 既存テストのrequest countと順序を基準化し、必要であればテスト用のmock/SQLite計測で、操作完了までのHTTP request数、DB query数、応答時間を同じ条件で比較する。認証情報や個人データをログに残さず、本番書き込みを伴う計測は行わない。
3. 進行中poll、mutation開始、POST応答適用、poll再開の順序を確認する。`version` / `snapshotRevision` だけで新旧を推測せず、既存sequence/abort制御を維持する。reset時のrevisionの意味を確認し、resetやaggregate後に旧ready値を補完しない。
4. POST bodyをUI状態へ採用する案では、`unknown` payloadをruntimeで検証し、欠損・不正payloadや不一致時はGETで再同期する。POST bodyだけで正しい状態を表せない場合はGETを維持する。API DTO拡張や追加readが必要になり、追加負荷や状態分岐が削減効果を上回る場合も現状維持とする。
5. 削減を採用する場合の条件は、対象actionの成功後に即時GETが1回減ること、表示内容・認証復旧・失敗時の再同期・競合排除を保つこと、DBを含む全体負荷が悪化しないこと。実測値を得るまでは節約量を記載しない。
6. publish/hideResultsは別APIで状態bodyを返さないため、この計測・削減候補から外す。失敗後のrefresh、ログイン/認証復旧、表示復帰も維持する。

### P2 — 実施結果と採否

| GET state / data | start後 | reset後 | aggregate後 | 取得元・採否 |
| --- | --- | --- | --- | --- |
| Control: `state`, `version`, `snapshotRevision`, `questionIndex`, `questionCount`, `projectionHidden` | state/version/indexが変わり得る。snapshot/question countは通常維持 | state/version/indexが変わり得る。snapshot/question countは維持 | snapshot revision/question countが変わり得る | POSTはこの6 control fieldsを返す。aggregate時は条件付きで`aggregationSummary`も返す。 |
| `participantResultsVisible`, `participantResultsReady` | visibleはaction外。readyは派生値 | visibleはaction外。旧ready値を補完しない | visibleはaction外。snapshot更新後にreadyが変わり得る | GETで取得。readyは`snapshotRevision > 0 && (questionCount > 0 || state !== "not_started")`から導出される。POSTには含まれず、GETを省略できない。 |
| `questions[]` | 通常維持 | 通常維持 | snapshot更新に伴い変化し得る | GETに含まれるが`getAdminState`はUI stateへ採用しない。 |
| `entries[]` | 通常維持 | 通常維持 | 集計更新に伴い変化し得る | GETに含まれるが`getAdminState`はUI stateへ採用しない。 |

`questions[]`は`id`、`question`、`choices`、`correctIndex`、`correctAnswer`、`explanation`、`answerType`を持つ。`entries[]`は`displayName`、`score`、`rank`、`isAggregationTarget`、任意の`answers[]`を持つ。これらを含むGET payload全体と、クライアントがstateとして採用する項目は区別する。

`tests/app/admin/presentation-admin.test.tsx`の「keeps polling paused while an administrator action is pending」は、初期GET 1回、reset POST 1回、操作中pollによるGET追加なし、成功後GET 1回を確認する。startの既存テストはstart POSTとGETの存在は見るが、POST後GETの正確な回数/順序は固定していない。`readAdminPresentation`はsession/questions/entries/settingsの最大4 SELECTを読み、POST応答用control readは1 SELECT。これはコード上のread数であり、query latencyやtransaction待ち時間の実測値ではない。既存のDB query/transaction/response-time計測器が見当たらず、同条件のDB負荷比較は未実施。HTTP GET削減がDBを含む全体負荷を改善する証拠がないため、start/reset/aggregateすべてでPOST後GETを維持する。

管理画面のpoll pause、single-flight、sequence/abortによる古い応答排除、失敗時の再同期、401時の認証復旧は変更していない。

## Technical Key Points

- 表示DTOは明示的なallowlistで作り、内部結果フィールドの追加がAPI応答へ波及しないようにする。
- repository型はtype-onlyで参照する。表示契約/parserをDB実装へ依存させず、不要な型移動を避ける。
- participant resultsとshared-resultsでは認証、credentials、失効status、応答raceの契約が異なる。類似コードだけを理由にhookやエラー処理を統合しない。
- 管理POSTの6 control fieldsとGETのvisible/ready fieldsを別契約として扱う。GET削減は全actionのmutation後状態が説明できてから決める。
- pollのsingle-flight、操作中のpause、既存sequenceによる古いresponseの排除、timeout/abortを維持する。`version` / `snapshotRevision` の意味を推測に使わず、POSTを使う場合はruntime schema検証とfallback GETを設ける。状態更新順を変える場合はslow responseも含めて検証する。
- 結果APIの認証・scopeと`no-store`、共有結果の匿名性を保つ。表示DTOの共通化はデータ取得やアクセス制御の共通化を意味しない。
- 通信計測はローカル/テスト環境のrequest・queryカウンタを基本とし、個人情報・認証情報を出力しない。負荷改善はHTTP数とDB負荷を合わせて評価する。
- 要件に必要な通信を機械的に削るより、計測で不要性を確認して採否を決める。削減できない結論も有効な調査結果とする。

## 実装フェーズ

1. 実装開始時に作業ツリーとPlan 65/77/80/95/96の関連箇所を再確認し、関連SSR/API/adminテストの本文と現在のrequest期待値を読む。
2. P1 mapperと2 callerのみを変更する。必要な不足契約テストを絞って追加し、実装内容が本計画の境界と一致することをOrchestratorが差分レビューする。
3. P2のaction別状態表と通信/DB baselineを作り、採否を記録する。削減条件を満たす場合だけ最小変更し、満たさなければGETを維持して調査完了とする。
4. 実装でRequirements/API/構成に差が出る場合は `openspec/specs/stcirt/spec.md` を同期する。計画作成時点では仕様変更なし。テスト実装はfixer、テスト実行と検証ゲートはOrchestratorが担当する。

## 検証方針

### P1の関連テスト

- `tests/results/results-page.test.tsx`: assisted participantの初期結果、freeText/legacy answer形状。
- `tests/api/participant-results-route.test.ts`: 認証されたparticipantの返却フィールド、余分なフィールドを出さないproject。
- `tests/api/participant-results-route-sqlite.integration.test.ts`: signed-in participantのsnapshot rowと他entry非露出。
- `tests/results/results-panel.test.tsx`: private更新応答のparser、認証/更新UIとの整合。
- 専用mapperテストは、既存テストで覆われない非visible形状や内部フィールド非露出などの契約不足があれば追加する。単に実装の各行をなぞるテストは作らない。

### P2の関連テストと回帰条件

- `tests/app/admin/presentation-admin.test.tsx` の「keeps polling paused while an administrator action is pending」はPOST後GETの回数と順序を期待するため、変更の根拠に合わせて見直す。
- 成功/失敗action、401と認証復旧、ready/visibleの即時更新、操作中poll停止、遅いresponse、timeout、unmount、表示/非表示復帰、古いresponseの排除を確認する。
- mapperのみの変更なら上記P1関連suiteを中心にする。管理UI/APIへ影響する実装時は該当admin unit/API/E2Eを追加する。

### 検証ゲート

- 対象テスト例: `pnpm exec vitest run tests/results/results-page.test.tsx tests/api/participant-results-route.test.ts tests/api/participant-results-route-sqlite.integration.test.ts tests/results/results-panel.test.tsx`。変更した範囲に応じてadmin testも加える。
- `src/` を変更した場合はリポジトリの規定に従い、type-check、lint、format、spec-refs、security、coverage等のpre-push/CI gateを実施する。必要なUI/API変更には該当E2Eを含める。
- `scripts/check-head-typecheck.sh`はコミット済みHEADを対象にするため今回の未コミット作業ツリーでは実行せず、代わりに`pnpm type-check`を実行してpass。専用script自体は未実行であり、push時のpre-push hookでは適用される。
- API契約変更時は `openspec/specs/stcirt/spec.md` のRequirements/APIを同期してspec-refsを確認する。本番build/securityおよびpre-push検証はリポジトリの通常手順を使う。
- 計画作成時点では計画ファイルだけを追加したため、その時点の内容・参照先レビューに加え`git diff --no-index --check -- /dev/null shared_plan/97-UNNECESSARY_COMMUNICATION_AND_MAINTAINABILITY_REVIEW_PLAN.md`を実行した。現在はsrc/とtest fixtureを変更しており、検証内容は下記実行ログに記録する。`shared_plan/**`はGitと`.oxfmtrc.json`のignore対象であり、format check済みとは扱わない。
- hooksを無効化しない。ローカル検証サーバーが必要になった場合の許可は `127.0.0.1:3001` に限る。

## 実行ログ

- 2026-10-25: ローカルコード、関連テスト名、既存計画を読み取り調査。不要と断定できる通信は未確認。結果DTO変換の重複を確認し、管理操作後GETの削減はDTO差と鮮度・負荷を理由に条件付き調査とした。
- 2026-10-25: 計画のみを追加。アプリ、テスト、仕様、依存関係、本番データに変更なし。実装と本番性能の検証は未実施。
- 2026-10-25: Orchestratorが上記no-index空白チェックを実行し、診断出力なし。`--no-index` の差分ありによる終了コード1。
- 2026-10-25: P1を実装。`src/lib/participant-result-projection.ts`にtype-only repository importと明示allowlistを備えたpure mapperを追加し、SSR pageとprivate participant results routeの2 callerで使用。認証・scope・status・`no-store`、answer variant、非visible shapeを維持。route test fixtureで内部フィールドがresponseに漏れない契約を強化。API/Requirements不変のため仕様書変更なし。
- 2026-10-25: P2のaction別GET/POST契約、state source、既存request順序を監査。POST後GETはstart/reset/aggregate全てで維持。既存テストが確認するresetのbaselineはinitial GET 1、POST 1、成功後GET 1、操作中poll GET追加なし。DB read数はコード上の確認のみで、性能実測・削減量は記録しない。
- 2026-10-25: 独立差分監査でP1のallowlist/type-only/caller境界、answer shape、auth/scope/no-store、shared-results/氏名/既存計画境界を確認。P1合格、P2のGET維持判断も妥当と判定。
- 2026-10-25: `pnpm type-check`、lockfile sync、format:check、lint:fast、spec-refs、security/secretlint、coverage suite（75 files / 1,256 tests、statements/branches/functions/lines各100%）、coverage tiers/completeness、本番buildがpass。コミット済みHEAD対象の`scripts/check-head-typecheck.sh`は未実行。E2EはChromium 40/40、Mobile Chrome 7/7 pass。今回の変更はDB schema/migrationを含まないため本番schema drift検出の対象外。
- 2026-10-25: 実装差分、P1/P2の採否、Technical Key Points、認証/鮮度/競合/公開境界、検証結果を計画全体と照合し、未達項目なしと確認。
- 2026-10-25: 実装後に計画ファイルを更新し、再度`git diff --no-index --check -- /dev/null shared_plan/97-UNNECESSARY_COMMUNICATION_AND_MAINTAINABILITY_REVIEW_PLAN.md`を実行。診断出力なし（差分ありによる終了コード1）。
