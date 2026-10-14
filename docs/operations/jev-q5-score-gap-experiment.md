# JEV 問5 score-gap 比較実験プロトコル

> **最新状態（2026-10-14）:** pilotの履歴runはすべて不変で保持。v3-01履歴条件 `fulfillment-semantic-01-v3` / rubric `jev-q5-fulfillment-v3-01` は初回6 + retry 4 + 3 + 3 + 3 = 19 dispatch、各run内retry 0。ユニーク答案6件すべて有効scoreあり。全成功分のknown usageは6,248 input / 108 output tokens、known cost subtotal USD 0.000262416。過去failed response 13件はusage/cost不明で実費合計不明。現在のproduction/pilot rubric pairはquestion `tamami-egg-v1` / rubric `jev-q5-fulfillment-v3-02`、raw 0–9、normalized `rawScore / 9`。weighted-score mismatchはwarning-only、response shape/type/range/probability sum validationは維持。v3-01の19 dispatchは旧prompt条件の履歴として保持し、v3-02結果とは扱わない。pilot rubric `jev-q5-fulfillment-v2` はraw/2、v3-01/v3-02はraw/9。productionの旧assessment rubric `tamami-egg-v1` もraw 0–2 /2だが別のversion系列である。既存スコアは変更・再計算せず、aggregationはcurrent v3-02以外のrubric assessmentを除外する。sh7の旧0–2 assessmentはDBで確認済み、sh9のDB provenanceは未確認。pilot結果は探索的で、評価品質の結論ではない。独立gold、untouched validation、full validation/adoptionは未実施。API/model比較はユーザー指示により実施しない。

round4完了後（履歴の確定値）: 初回6 + retry 4 + 3 + 3 + round4 3で累積19 dispatch（全run内retries=0）。B/C/Fはround4でweighted-score mismatchをwarningとして記録しつつ成功し、A〜F全6件が少なくとも1つ有効scoreを持つ。round4 run `jev-q5-invalid-retry-round4-20261013221312643-4f8e4eeb-228a-4623-9648-73d55b5b1eec`。round4 usageは3,131 input / 54 output tokens、known cost subtotalはUSD 0.000131502。累積known usageは6,248 input / 108 output tokens、known cost subtotal USD 0.000262416。過去failed response 13件はusage/cost不明のため実費合計も不明。round4のper-ID結果は下記表を参照する。

## 0. 実験開始ゲート

ここで列挙する事前登録ゲートはfull validationおよび将来のbaseline/candidate比較用。凍結6件の今回pilotはユーザー指定の6 request thresholdに従って既に完了しており、未設定項目はその完了を取り消すものではない。

- 実験責任者 / 記入日時: `[未設定]`
- 問題オーナー、人手基準への合意記録: `[未設定]`
- 独立評者2名の匿名化・独立性確認（元score、参加者名、model結果を知らない）: 今回のpilotではユーザー指示により一時省略。full validation/adoption前に独立評者が必要か再検討し、判断を記録: `[未設定]`
- API資格情報: 完了済みpilotの実行時にローカル環境へ設定して使用した。秘密値や保存場所は記載しない。
- 今回の回数上限: 旧runはユーザー指定どおり6 requestで完了。費用上限は指定されていない。runnerのUSD 0.01は任意の二次post-response circuit breakerであり、hard capでもユーザー指定の費用上限でもない。
- 新rubric再採点条件（実行前登録）: condition `fulfillment-ordinal-100-v2`、rubric `jev-q5-fulfillment-v2`、config `jev-q5-run-config-v2`、artifact schema `jev-q5-run-artifact-v2`。6件各1回、`maxRequests=6`、再試行なし。新runは既存run `jev-q5-20261012233848586-0773810a-d099-408a-996f-3d549f1a3980`をsupersedeするが、旧artifactは不変。USD 0.01は二次停止値であり、ユーザー承認済み費用上限ではない。条件は事前登録後に実行済み。
- v3-01 historical rubric/run condition（round3完了時点、round4実施前）: condition `fulfillment-semantic-01-v3`、rubric `jev-q5-fulfillment-v3-01`、config `jev-q5-run-config-v3-01`、artifact schema `jev-q5-fulfillment-run-artifact-v3.schema.json`。初回は凍結6件各1回、`maxRequests=6`。criteriaは0〜9の10段階で、native raw scoreを保ちつつ `score01 = rawScore / 9` を保存前に検証する。質問と参照解答はproductionの固定値と同一で、参照解答はrequest configに記録され、そのhashが各artifactに残る。初回run `jev-q5-20261013132506165-0e6709af-b034-4ce7-8615-440183b07ae6` はv2 run `jev-q5-20261013110343293-c93b0fea-3796-4310-9c3d-2c5ab5e7891f`をsupersede対象として記録する。残り4件はcontinuation `jev-q5-20261013133540578-e4439186-1982-40ff-8470-e46f684966e7`で送信した。初回6件のknown cost subtotalはUSD 0.000087024。初回でB/C/E/Fのfailed artifactがありusage/costはunknownだが、正確なfailure kindは未検証。第1回限定retryは4 request・retry 0で完了し、run `jev-q5-invalid-retry-20261013142609999-42dc70db-f388-480b-bd73-5e100d36c727`を使用した。第2回限定retryはB/C/Fへ各1 request、計3 request・retry 0で完了。run `jev-q5-invalid-retry-round2-20261013143859119-b2e07787-228c-4d17-bff5-c69a066366c3`、artifact path `.local/jev-q5-score-gap-runs/invalid-response-retry-v3-round2/runs/jev-q5-invalid-retry-round2-20261013143859119-b2e07787-228c-4d17-bff5-c69a066366c3/`。この時点では累積16 dispatch、usable scoreはA/D/Eの3件、failed response 13件はusage/cost unknown。既知usageは3,117 input / 54 output tokens、known cost subtotalはUSD 0.000130914、実費合計は不明。USD 0.01は初回runに設定された二次停止値で、費用上限ではない。round4以降の最新結果は冒頭の更新および第4回限定retry節に記載する。
- 追加の限定再実行（完了）: `q5-pilot-fixture-e` のみを同じfulfillment-v2条件で1 request、retry 0で採点した。run `jev-q5-20261013111546479-51d41c4d-1dc1-4643-83f1-97b02a4cc821` は直近のfulfillment-v2 run `jev-q5-20261013110343293-c93b0fea-3796-4310-9c3d-2c5ab5e7891f`をsupersede対象として記録。raw score 0.83/2、score100 41.5で、前回v2の41.5から変化なし。usageは802 input / 18 output tokens、既知costはUSD 0.000033684。旧6件runおよびそのartifactは不変。
- P0データセット固定記録と全体のアクセス管理手順・承認: `[未設定]`。今回の6件の入力と暫定評定はowner-onlyのlocal fileへ保存し、今回のpilot用に固定済み。個別pilot fileの保護と、評価データ全体のガバナンス記録・アクセス管理承認は別項目である。
- 実submission ID ↔ 安定匿名答案ID/source revisionの対応表の保管場所・アクセス担当（保護領域のみ）: `[未設定]`
- 下記の全事前登録項目が確定し、実行担当者が確認した日時: `[未設定]`

旧semantic-match rubricによる第1回6件pilotは、ユーザー指定のrequest count上限6件で完了した。実際の合計費用は応答後にUSD 0.000130872と記録された。USD 0.01 post-response guardは発火しなかった。この実績はユーザーが費用上限を指定・承認したことを意味しない。**round4前のv3費用履歴:** 初回6 dispatchのknown cost subtotalはUSD 0.000087024、round3完了時点まで（累計16 dispatch）のknown cost subtotalはUSD 0.000130914だった。**round4完了後の現在値:** 累計19 dispatch、6答案すべてに有効scoreがあり、cumulative known cost subtotalはUSD 0.000262416。failed response 13件はusage/cost不明のため実費合計は不明である。将来の別実験では費用上限を事前に設定する。資格情報や答案本文はこの文書・artifactに書かない。

## 1. 人手基準と比較ペア（P0）

- 対象質問と出典の固定版/参照: `[未設定]`
- 許容される最小十分回答、および必須要素: `[未設定]`
- 任意要素、許容する省略・言い換え、関連補足の扱い: `[未設定]`
- 旧human基準は問題オーナーによる意味一致度0–9の暫定ordinal評定。これは旧JEV条件との比較用で、新rubricの独立goldではない。旧JEV raw score 0–2およびv3 raw score 0–9とは別基準・別尺度である。
- 承認済み端点（問題オーナー、2026-10-12）: 0 = 設問に関係しない/誤り、9 = 設問に完全回答し意味が一致。
- 0–9中間値はordinalとして扱う。各中間値の具体的anchor定義: `[未設定]`（端点承認は中間値の定義・各答案評定の承認を意味しない）。
- human ratingが異なる答案pairの作成/除外規則: `[未設定]`。同じ0–9人手ratingの答案pairはprimary pairに含めない。
- 曖昧・矛盾・無関係・背景のみ・正しい補足のみの扱い: `[未設定]`
- 評者判定手順、記録形式、匿名化担当: `[未設定]`。今回のpilotは問題オーナー評定のみ。独立評者の必要性はfull validation/adoption前に再検討する。
- 不一致の照合手順（設問・出典根拠を確認する担当と手順）: `[未設定]`
- 照合後も不一致が残る答案の隔離/除外規則: `[未設定]`
- 比較ペア定義: 0–9のhuman ratingが異なる匿名答案IDの組 `[未設定]`。人手ratingが同じ答案、または評定未確定の答案はprimary pairに含めない。
- 主評価対象を網羅する層（同義表現、具体化、正しい補足、背景のみ、宣言/実行のみ、矛盾、誤った長文等）と各層の定義: `[未設定]`

### セット分離と凍結

- 開発/調整用セットID、匿名答案ID一覧の保管先、revision一覧: `[未設定]`
- 未使用検証用セットID、匿名答案ID一覧の保管先、revision一覧: `[未設定]`
- 各セットのopaque dataset IDと限定保管manifest参照: 開発 `[未設定]` / 検証 `[未設定]`
- 各セットのmanifest hash（答案本文自体ではなく、固定manifestのhash）: 開発 `[未設定]` / 検証 `[未設定]`
- セット間の重複・近似答案を調べる担当と結果: `[未設定]`
- 固定日時、凍結担当、アクセス権: `[未設定]`

現在ローカルdev用pilot dataset `[.local/jev-q5-score-gap-pilot.json](../../.local/jev-q5-score-gap-pilot.json)` に6件を記録し、入力と問題オーナー単独の暫定human 0–9評定を凍結した。個々の答案本文・匿名IDと評定の対応はこの文書に記載しない。評定は問題オーナー単独の暫定0–9 ratingで、現在のfulfillment rubricの独立goldやvalidationではなく、独立評者はユーザー指示により一時省略。full validation/adoption前に必要性を再検討する。0/9端点は2026-10-12に承認されたが、中間値のanchor定義は未設定。ファイルは`.gitignore`で除外し、owner-only mode 0600、格納ディレクトリは0700にする。実submission ID、対応mapping、system score/confidenceは含めない。固定6件はdev pilot専用でuntouched validationや採用判断には使わない。sh7/sh9の過去JEV score/confidenceはhuman gold dataに含めない.

run artifact schemaはmodel-onlyとし、human 0–9 gold labelを同じrecordに含めない。human labelsはこのlocal-only pilot datasetに匿名答案IDで別保存し、将来の比較時に限定された解析工程内で匿名IDを使って対応づける。run artifact schemaは`additionalProperties: false`であり、人手label項目を追加できない。

### 6件pilotの既存assessmentによるoff-line descriptive ranking check

旧datasetには、問題オーナー単独で評定した6件の暫定human 0–9ラベルがある。個別答案・ID・ラベルの対応はlocal-onlyデータに隔離し、この文書には記録しない。旧assessment値が利用できたのはその一部だけで、旧基準で観測できたpairは1/14だった。

これはowner-only provisionalな6件dev pilotの不完全coverageによるoff-line記述集計であり、human rating後にscoreを照合したため暫定ラベルをscoreで汚染していない。既存assessment値だけの集計ではAPI replay等を行っていなかったが、後続のユーザー指示で現行JEV APIへ6件を各1回送ることが許可され、実行済みである（結果は次項）。過去値の再現、同時期paired/repeated runs、現行baselineとcandidateの比較ではない。これは `single_condition_descriptive` の採点であり、探索的・暫定的な記述結果に限り、一般的なmodel quality、統計的効果、原因帰属、採用は主張しない。再試行せず、assessment production DBは変更しない。runnerのUSD 0.01はエージェントが選んだpost-response circuit breaker thresholdであり、ユーザーの明示承認済み費用上限ではなく、provider側のhard capでもない。利用量不明の応答では後続requestを停止するが、進行中requestの費用超過は防げない。

### 新rubricによる6件再採点（実行結果）

ユーザー指示に基づき、JEVの採点指示を意味類似度から「設問が求める情報をどれだけ正しく十分に満たすか」へ変更する。問5で求める中心情報は珠美が卵を実際にしばらく買わなかった行動である。回答に必要な情報の欠落・説明不足、事実誤認・意味の取り違え・矛盾を減点する。春闘・賃上げ要求・一時金など設問が尋ねない周辺事情は必須にしない。正しい言い換えを認め、流暢さや長さだけでは加点しない。ordinal criteriaは0=問われた行動がない/重要な誤り、1=行動が一部示されるが不十分・曖昧/重要な誤り、2=卵を実際にしばらく買わなかったことを正しく示す、の順とする。

再採点は既存runを編集せず、新しいcondition `fulfillment-ordinal-100-v2`、rubric `jev-q5-fulfillment-v2`、config `jev-q5-run-config-v2`、schema `jev-q5-run-artifact-v2`で6件各1 request、`maxRequests=6`、retryなしで実施し6/6成功した。新run/artifactは旧run `jev-q5-20261012233848586-0773810a-d099-408a-996f-3d549f1a3980`をsupersede対象として明示する。provider-native `rawScore` 0–2を保持し、表示値は `score100 = rawScore * 50` で計算した。human 0–9評定は独立した旧semantic-match基準であり、新rubricの判定データとして使用しない。旧14-pair / 9-concordant (64.3%)集計は旧基準だけの結果で、新rubricの改善・一致度として解釈しない。

実行コマンドは `pnpm exec tsx scripts/run-jev-q5-pilot.ts --max-requests 6`。6 requestを1回ずつ送り6/6成功、再試行なし。個別答案IDごとのraw scoreと100点換算はignored local run artifactだけに保存し、この文書には記載しない。usage合計はinput 4,790 / output 108 tokens、記録費用USD 0.00020118。artifactは`.local/jev-q5-score-gap-runs/jev-q5-20261013110343293-c93b0fea-3796-4310-9c3d-2c5ab5e7891f`。runnerはv2 strict artifact structureを保存直前に検証し、成功artifactで`score100 = rawScore * 50`を浮動小数点epsilon内で確認した。API/model比較・production DB write・retryなし。USD 0.01は任意のagent-selected post-response circuit breakerであり、ユーザーが承認した費用上限ではない。

### v3-01意味充足rubricのpilot履歴（dispatch完了・採点実験は結論不能）

当時のv3-01 promptは、回答が設問の意味をどの程度満たすかを0〜9で採点し、情報不足・誤り・矛盾を減点し、正しい言い換えを認める指示だった。そこには参照回答に含まれる春闘・賃上げ要求・一時金を必須要件にしないとする文が含まれていた。これは過去19 dispatchのprompt履歴であり、現行v3-02 promptには引き継がない。criteriaには数値anchor 0〜9を使い、回答例は含めない。JEV native raw score 0〜9と確率を保持し、正規化値は `score01 = rawScore / 9` として保存前に検証する。加重期待値は整数間になり得るため整数への丸めを行わない。**v3 pilot runner実装時点では**Q5 pilot runnerとlocal artifactだけの変更で、production adapter/DB contractは変更していなかった。その後のproduction rubric portは下記に記録する。

このv3-01条件のquestionとexpected answerはproductionの固定値と一致し、現在も変更していない。v3-01とv3-02はrubric versionが異なる。参照解答はv3 request configに記録され、そのhashはrun artifactに保存される。rubricとartifact schemaの形式は専用のv3 artifact schemaで定義する。

2026-10-13に同一凍結6件へ各1回、初回の合計6 dispatchを完了した。初回run `jev-q5-20261013132506165-0e6709af-b034-4ce7-8615-440183b07ae6` はv2 run `jev-q5-20261013110343293-c93b0fea-3796-4310-9c3d-2c5ab5e7891f`をsupersede対象として記録し、A/Bをdispatchした。request Aは成功しraw score 6.27/9、`score01=0.6966667`、usage 1,027 input / 18 output、known cost USD 0.000043134。request Bはfailedでusage/cost不明となり、正確なfailure kindは未検証。残るC〜Fはcontinuation `jev-q5-20261013133540578-e4439186-1982-40ff-8470-e46f684966e7` で各1回dispatchし、Dは成功raw score 1.65/9、`score01=0.1833333`、usage 1,045 input / 18 output、known cost USD 0.00004389。C/E/Fもfailedでusage/cost不明、正確なfailure kindは未検証。初回6 dispatchのknown usage subtotalは2,072 input / 36 output tokens、known cost subtotalはUSD 0.000087024。以下の累積結果表では後続の限定retry結果も合わせて示す。初回run artifactは`.local/jev-q5-score-gap-runs/jev-q5-20261013132506165-0e6709af-b034-4ce7-8615-440183b07ae6`、continuation artifactは`.local/jev-q5-score-gap-runs/jev-q5-20261013133540578-e4439186-1982-40ff-8470-e46f684966e7`。v1/v2の既存artifactは変更せず、assessment production DB writeなし。

初回passだけの結果（この表のB/C/E/Fの初回failed状態（failure kind未検証）。手動評定は問題オーナーが設定した既存の暫定labelで、JEV結果とは別尺度・別列）:

| 答案ID | 初回JEV結果（raw / 9） | 初回score01 | 問題オーナー手動評定（0–9） | 初回状態                 | 初回usage / cost                   |
| ------ | ---------------------: | ----------: | --------------------------: | ------------------------ | ---------------------------------- |
| A      |                   6.27 |   0.6966667 |                           2 | succeeded                | 1,027 in / 18 out; USD 0.000043134 |
| B      |            unavailable | unavailable |                           6 | failed (kind unverified) | unknown                            |
| C      |            unavailable | unavailable |                           7 | failed (kind unverified) | unknown                            |
| D      |                   1.65 |   0.1833333 |                           5 | succeeded                | 1,045 in / 18 out; USD 0.00004389  |
| E      |            unavailable | unavailable |                           8 | failed (kind unverified) | unknown                            |
| F      |            unavailable | unavailable |                           2 | failed (kind unverified) | unknown                            |

手動評定列は問題オーナーによる既存の暫定ラベルであり、独立評者や独立goldのスコアではない。表の初回結果では6件中有効scoreは2件だけだった。後続retry後は6件すべて有効scoreを得た（累積表を参照）。意味充足評価の妥当性・順位一致率・改善は評価しておらず、結論不能とする。

#### shared_plan/61 実施照合

| 計画項目                                                            | 状態                | 根拠 / 残作業                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| productionと同じ問・参照情報、意味充足rubric、0–9 criteria、0–1表示 | v3-01で完了         | 問・参照は現行と同じ。rubric v3-01で19 dispatch。score01をrawScore / 9で保存                                                                                                                                                                                                         |
| 固定6件の初回dispatchと4回の限定retry、記録の保持                   | dispatch完了        | 初回A〜Fは各1 attempt・初回run内retry 0。第1回retryはB/C/E/F、第2回〜第4回retryはB/C/Fへ各1 request（各run retry 0）、累計19 dispatch。A〜Fすべて有効scoreあり。round4はweighted-score consistency rejectionを無効化し、deltaをwarning metadataとして保存                            |
| 手動評価との照合                                                    | 部分完了            | 問題オーナーの暫定0–9評定を別列で記録。独立評者・独立goldではない                                                                                                                                                                                                                    |
| 独立評者と不一致裁定                                                | 未完了              | 独立性確認、独立評定、裁定手順が未実施                                                                                                                                                                                                                                               |
| 十分なdev標本と独立untouched validation                             | 未完了              | 標本設計、分割、固定manifest/hash、untouched validationが未作成                                                                                                                                                                                                                      |
| 反復数・request/spend上限・同点幅・最小改善幅・guardrail・採用基準  | 未完了              | 別runごとのrequest capは初回6、第1回retry 4、第2回retry 3、診断付きround3 3、weighted-delta warning-onlyのround4 3（全run内retries=0）。weighted-score consistency rejectionを無効にしたのはround4だけで、deltaはwarning metadataに記録。全体のspend capとadoption thresholdは未設定 |
| paired baseline/candidate、順位指標、不確実性評価                   | 未実施              | API/model比較はユーザー指示により行わない。独立goldとuntouched validationがなく、順位・不確実性を評価できない                                                                                                                                                                        |
| production/pilot current rubric pair                                | 実装完了・API未実行 | question `tamami-egg-v1` / rubric `jev-q5-fulfillment-v3-02`。instructionは両実装で一致。問題文と参照回答は据え置き                                                                                                                                                                  |
| historical pilot                                                    | 完了（v3-01）       | 過去19 dispatchとそのscoreをv3-01の旧指示履歴として保持。再生成・再採点なし。v3-01 rows/artifactsはcurrent pairではない                                                                                                                                                              |
| evaluation-based adoption gate / DB data write                      | 未完了 / 未実施     | code portはユーザー指示により反映。6件の記述scoreだけではfull validation/adoption gateを満たさず、assessment DBへのwriteやaggregate再計算はしていない                                                                                                                                |

したがってshared_plan/61の6件を用いた初回dispatchと、失敗対象への4回の限定retryは完了したが、プラン全体は完了していない。上記のvalidation・独立gold・採用ゲートを完了するまでは採用判断へ進まない。この箇所はround4前に記録した履歴状態であり、最新のdispatch数・score取得状況は本書冒頭と累積結果表を参照する。

### Production rubric port（2026-10-14）

本番adapterとpilot runnerのQ5 current scoring instructionsを一致させ、rubric versionを `jev-q5-fulfillment-v3-02` とした。question versionは `tamami-egg-v1` のままで、問題文と参照/expected answerは変更していない。0〜9 ordered anchorsを使用し、情報不足・誤り・取り違え・矛盾を減点し、正しい言い換えを許容し、文体や長さのみでは加点しない。現行指示から「春闘・賃上げ要求・一時金などは必須でない」とする文だけを削除した。raw scoreは0〜9、正規化値は `rawScore / 9`。pilot rubric `jev-q5-fulfillment-v2` はraw/2、v3-01とv3-02はraw/9。productionの旧assessment rubric `tamami-egg-v1` もraw 0–2 /2だが、v2 pilotとは別のversion系列として保持する。

responseのJSON shape、必須key、型、score/confidence/probability範囲、probability sum検査は維持する。returned scoreとprobability weighted scoreの差は数値診断warningとして記録し、それだけを理由にrejectしない。production旧assessment rubric `tamami-egg-v1` のraw 0–2 /2値と、pilot rubric `jev-q5-fulfillment-v2` のraw 0–2 /2値は別version系列として保持し、どちらも書き換えずbackfill/regradeしない。DB migration、assessment DB write、aggregate再計算は行っていない。sh7は以下のread-only DB照合で旧0–2 recordを確認し、現行v3とはrubric versionが異なるため比較しない。sh9は未確認のまま分離する。

#### shared_plan/61 最終照合

| 区分                        | 状態                            | 内容                                                                                                                                                                                   |
| --------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完了                        | API dispatch                    | 初回6 + 限定retry 4 + 3 + 3 + 3 = 19 dispatch。6 unique itemsすべてに有効score。request capはrunごとに6/4/3/3/3、run内retry 0。                                                        |
| 完了                        | 手動anchor入力                  | A=2、B=6、C=7、D=5、E=8、F=2を別列で保持。独立評価者やgoldとは扱わない。                                                                                                               |
| 完了（実装）/ 未実施（API） | production/pilot current rubric | question `tamami-egg-v1`、rubric `jev-q5-fulfillment-v3-02`、raw 0–9、normalized raw/9、両側のinstruction一致。weighted mismatch warning-only。question/refは不変。v3-02 API runなし。 |
| 履歴保持                    | v3-01 pilot                     | 19 dispatchとscoresはv3-01 prompt historyとして保存。raw/9は維持し、v3-02へ再生成しない。v3-01 rows/artifactsはcurrent pairでないためaggregation対象外。                               |
| 部分完了                    | 評価データ                      | 6件の単一pilot結果を得たが、独立goldではなく、妥当性/順位一致/効果は評価できていない。13 failed early attemptsのusage/costとexact error kindは復元不能。                               |
| ユーザー指定で除外          | API比較                         | API/model/prompt comparisonは実施しない。                                                                                                                                              |
| 一時省略                    | 独立2評者                       | pilotではユーザー指示により省略。full validation/adoption前に必要性を再検討し、必要なら独立評定と裁定を行う。                                                                          |
| 未実施                      | validation/adoption             | 中間anchors、十分なdev/untouched validation、pairwise metricの不確実性、adoption threshold/guardrails、untouched validation、他設問のregression、評価に基づく採用判断。                |
| 部分確認                    | DB provenance                   | sh7の旧0–2 rowは確認済み。sh9は未確認で、現行v3の評価に混ぜない。                                                                                                                      |

費用記録の既知分は6,248 input / 108 output tokens、USD 0.000262416。失敗13件のusage/costが不明のため実費合計は確定できない。USD 0.01 post-response guardは各pilot runnerの任意guardで、費用上限ではない。全体spend cap・採用thresholdは設定されていない。

#### 残り4件の限定continuation（実行完了）

continuationは親run `jev-q5-20261013132506165-0e6709af-b034-4ce7-8615-440183b07ae6` のmanifest/request config/artifactを照合し、開始時点でA/Bだけがattempt済み、A成功・B失敗でusage不明、c〜fが未送信であることを確認した。manifest/config hash、親run lock、全6件のHMAC fingerprint set、A/B attempt marker、artifactのstrict structure、Aの保存response hash/score/costを突合し、欠落・不一致・検証不能な証跡があれば停止する。attempt markerは親run用のcondition key内でA/Bのみ存在することを確認し、他conditionにある旧run markerは読み取り専用で保持した。productionと同じ固定question、expected answer、rubric、criteriaを使い、選択ID、親run、`maxRequests=4`、`retries=0`をrequest configとlineage artifactへ記録した。親runで既知のinput costはUSD 0.000043134、Bのcostは不明。continuationではDのみusage/costが確定し、C/E/Fのusage/costは不明。

既存runのattempt markerは読み取りのみで、変更しない。新しい親run限定claimと各答案のexclusive pre-dispatch claimを作り、claimが存在する場合は自動replayを拒否する。HTTP応答を受信した後の形式不正・usage不明では残りrequestへ進み、4 request capだけをhard stopとして適用する。応答を受け取れずdispatchが曖昧な場合は停止し、claimを保持して自動再送を拒否する。artifact schemaの`supersedesRunId`は既存のv2 runを指す固定constのため変更しない。v3 continuationは同じv3条件の未送信答案を補完するrunであり、直前partial runとの親子関係はrequest configとlineage artifactの`continuationOfRunId` / `parentRunId`に保存する。履歴はv2 run → 初回v3 partial run → continuationとして追跡する。

実行コマンド: `pnpm exec tsx scripts/run-jev-q5-pilot.ts --continue-parent jev-q5-20261013132506165-0e6709af-b034-4ce7-8615-440183b07ae6 --record-ids q5-pilot-fixture-c,q5-pilot-fixture-d,q5-pilot-fixture-e,q5-pilot-fixture-f --max-requests 4`。dispatchは4/4、成功1/4。

### 旧semantic-match rubricによる第1回6件API採点（履歴）

凍結6件について現行JEV APIへ6 requestを送り、6/6成功した。すべてretryなし、assessment production DB writeなし。応答のmodelは`jev-1.13.0`、question/rubric versionは`tamami-egg-v1`、submission/fixture revisionは1。合計usageはinput 3,116 tokens、output 108 tokens、記録費用はUSD 0.000130872。ユーザー指定のrequest-count thresholdは6であり、6件で停止した。実行artifactには、これとは別にエージェントが選んだUSD 0.01 post-response guardが設定されていたが発火していない。これはユーザー指定のspend capではない。

旧semantic-match human基準の暫定ordinal labelsで計算した14 eligible pair（全15組から同点1組を除外）では、9組がconcordant、5組が逆順、model tieは0組、pair agreementは9/14 = 64.3%。この集計は旧rubric・旧human基準だけに対応し、新rubricの評価値として流用しない。単一owner-provisional pilotの探索的記述集計であり、独立gold、統計的効果、一般的品質や採用を示さない。個別答案本文・human label・対応はこの文書に記載しない。旧API scoreと表示確率再計算の差は許容差内である。

セット割当と人手ラベルをAPI実行前に凍結する。候補選択・prompt調整には開発セットだけを使う。未使用検証セットは候補選定後に一度だけ使用する。検証結果を見て候補・基準を調整した時点で、その検証セットは未使用ではなくなる。新しい未使用セットを確保・凍結できるまで採用判断をしない。答案のrepeat/runは答案数や独立答案として数えず、答案ID単位の対応を保つ。

この計画は固定匿名答案セットのindividual run比較に限定する。anonymous answer IDは同じ元submission/fixtureの全runで安定させ、revisionは元submission revision（合成答案ならfixture revision）を指す。実submission IDとの照合はアクセス制限した別mappingで行い、artifactには実submission IDや参加者IDを記録しない。artifactにはsource kind、opaque dataset ID、凍結manifest参照/hashを記録する。公開済みaggregateの比較はこの実験の範囲外とし、別途行う場合に限りaggregate時のquestion/rubric snapshot mapを照合する。aggregate snapshotを個別答案のQ/R versionやsubmission revisionの代用にしてはならない。

## 2. 比較条件と候補の固定

下記のbaseline/candidate項目は、今回の6件を現行条件で一度だけ採点する記述pilotには適用しない。候補を比較する別の将来実験を行う場合の未設定項目であり、今回API/model/prompt A/B比較を行う計画を意味しない。

- baseline ID / 説明 / 凍結したrequest・設定参照とhash: `[未設定]`
- candidate ID / 説明 / 凍結したrequest・設定参照とhash: `[未設定]`
- 候補の変更差分（expected answer、instructions、rubric等を一度に混ぜない）: `[未設定]`
- 変更しない要素（質問、model alias、利用可能なmodel実ID、出力schema等）: `[未設定]`
- model実IDの取得方法と、実行ごとの記録方法: `[未設定]`
- question/rubric version pair: `[未設定]`
- 入力生成・正規化・HMAC-SHA-256 fingerprint手順、key ID/保護keyの保管先と、匿名答案ID/revisionとの対応: `[未設定]`
- APIが公開する固定可能な実行設定、固定値と参照: `[未設定]`

将来candidate/baselineを比較する場合、baseline再実行は過去assessmentの再現ではなく、候補と同時期・同じ凍結答案でpaired実行する。今回のpilotでは候補比較は行わない。APIが公開しないtemperature/seed等の固定を要求せず、固定不能な設定とその制約を記録する。答案を含むcanonical inputはHMAC-SHA-256でfingerprint化し、artifactにはdigestとopaque key IDだけを記録する。鍵materialはartifact外の保護領域に保管する。単純SHA-256は短い答案の辞書推測が可能なため答案payloadに使わない。`requestConfig.sha256`の対象は答案入力を除く非回答設定snapshotに限る。資格情報、答案本文、回答を含むerror detailはartifactやログに記録しない。

## 3. 実行計画と事前しきい値

- 時間ブロックの定義、各ブロックの候補/baseline対の割当: `[未設定]`
- 各ブロック内の実行順の乱数化方法、seedまたは乱数記録参照: `[未設定]`
- 候補・baseline・答案の提示/実行順を匿名化して乱順化する手順: `[未設定]`
- planned replicate index（答案・条件ごとの事前登録反復番号）とpair IDの採番/対応規則: `[未設定]`
- 比較ペア数（答案ペア数）: `[未設定]`
- 各答案・各条件の反復数（同一答案の繰返しであることを明記）: `[未設定]`
- 反復数の根拠、除外/再試行規則: `[未設定]`
- 費用上限（通貨、上限値、承認参照）: `[未設定]`
- 1回あたりまたは累積費用の停止条件: `[未設定]`
- 同点許容幅（raw score差）: `[未設定]`
- 主指標の最小改善幅: `[未設定]`
- 逆転率、許容幅内同点率、反復ばらつきの上限: `[未設定]`
- guardrailsと各許容値（同程度答案間の差、正しい補足の扱い、誤答/背景のみへの誤加点、最高アンカー整合等）: `[未設定]`
- 不確実性の算出方法と集計単位（答案ペアを単位とし、反復を独立標本にしない）: `[未設定]`
- 採用/保留/棄却の判定規則と判定者: `[未設定]`

旧semantic-match rubricによる第1回pilotでは、凍結済み6件を現行JEV APIへ各1回送信し、6/6成功した。14 eligible pair中9 concordant、5 reversed、model ties 0という結果だった。この9/14 (64.3%)は旧human semantic-match基準に基づく第1回runだけの記述値で、v3-01/v3-02の一致率・改善値ではない。旧semantic-match runではretry・API/model/prompt A/B比較・assessment production DB writeを行っていない。これはsingle-condition exploratory pilotであり、推測統計・因果効果・一般的品質・採用判断には用いない。fulfillment rubric v3-01は初回passと4回の限定retryを行い、累計19 dispatchでユニーク6件すべてのscoreを得た。これらはv3-01旧指示の履歴で、独立goldとuntouched validationがなく採用判断は保留する。v3-02はcurrent prompt/versionで、API実行なし。fulfillment-v2の6件再採点は別の完了runとして保持する。より広いP1のbaseline/candidate比較、full validation/adoptionは未完了。request数は初回6件、第1回retry 4件、第2回〜第4回retry各3件で累計19 dispatch。ユーザー指定のspend capはなく、結果artifactはlocal-onlyに保存する。人手0–9 ratingとJEV raw score 0–9は尺度の値域が同じでも、別基準として保持する。v3-01/v3-02のscoreはどちらもraw/9。API比較はユーザー指示により実施しない。

将来v3 rubricで候補比較を行う場合は、primary/guardrail scoringにnative raw score 0–9を用いる。humanの0–9は問題オーナーによる暫定順序ラベルであり、現状は独立goldではない。candidate/baseline scoreはhuman labelと同一尺度として扱わず、答案pairの順位を比較する。normalized score `rawScore / 9`は表示値であり、採点品質指標・採用判定の代替にしない。confidenceはscoreにも採用判定にも寄与させない。各baseline/candidate runは同じ安定匿名答案ID、source revision、planned `replicateIndex`、time blockの組で対応づけ、同じopaque `comparisonPairId`を共有させる。`attempts`は同一run内の内部試行/retry数でありplanned replicate数ではない。repeatは独立答案数に数えない。今回の6件一回ずつの記述pilotでは反復・paired候補比較を行わない。API比較はユーザー指示により実施しない。

## 4. 実行ログと採用

- run artifactの保存場所、アクセス制御、保持期間: `[未設定]`
- artifact JSON Schema: legacy [`jev-q5-score-gap-run-artifact.schema.json`](jev-q5-score-gap-run-artifact.schema.json); fulfillment v2 [`jev-q5-fulfillment-run-artifact-v2.schema.json`](jev-q5-fulfillment-run-artifact-v2.schema.json); semantic-fulfillment 0–1 v3 [`jev-q5-fulfillment-run-artifact-v3.schema.json`](jev-q5-fulfillment-run-artifact-v3.schema.json)
- 集計コード/版、集計担当、レビュー担当: `[未設定]`
- 次に問題オーナーへ確認する項目: (1) 中間値anchorをどの粒度で定義するか、(2) dev/untouched validation向けの追加実例と必要件数: すべて `[未設定]`
- 実行停止・障害・費用超過時の扱い: `[未設定]`
- 結果の不確実性、欠測、除外runの報告形式: `[未設定]`
- 採用判断・理由・承認記録: `[未設定]`

各実行は限定監査領域にrun単位artifactとして保存し、初回実験ではassessment production DBへ書き込まない。答案本文、秘密情報をartifactや一般ログに含めない。採用候補とするには、candidateのpairwise ranking concordanceがbaselineより事前登録した最小改善幅以上に上がり、未使用検証上で事前登録した不確実性条件を満たし、全guardrailを通過することを要する。

### 完了・採用条件

- primary metricは、human ratingが異なる答案pairのpairwise ranking concordanceとする。human tiesはprimaryから除外し、model tiesの0.5 creditとtie-rate guardrailを適用する。binary adequate/inadequate基準は設定・使用しない。
- 今回のpilotでは独立評者を一時省略する。full validation/adoption前に必要性の再検討を完了し、必要と判断した場合はその評定・裁定を完了する。
- candidate選択・調整にはdevセットのみ使用する。候補選択後にuntouched validationを一度だけ使ってcandidateとbaselineのconcordance差を評価する。
- validationを候補選択・調整・基準変更に使った場合、そのvalidationのuntouched性は失効する。新しい未使用セットを確保し凍結するまで採用しない。
- 完了には、未使用validation上でconcordance改善幅、不確実性条件を満たし、model tie rate・同一human-rating群の不要な分離など事前登録guardrailをすべて満たすことを要する。満たさない場合は不確実性と保留/棄却理由を記録する。

採用する場合も既存assessmentを上書きせず、新しいversion pairでappend-onlyに保存する。既存の公開aggregateは自動再計算しない。

### v3-01 failed response の限定再試行（完了・履歴）

ユーザーの再試行指示に基づき、前回v3 runで有効なscoreを得られなかった4件だけを対象とする専用CLIを追加した。実行コマンドは `pnpm tsx scripts/run-jev-q5-pilot.ts --retry-invalid-v3`。対象はB=`q5-pilot-answer-b`、C=`q5-pilot-fixture-c`、E=`q5-pilot-fixture-e`、F=`q5-pilot-fixture-f`に固定し、Aおよび成功済みDを再送しない。最大4 request、retry 0。通常の選択引数はこのモードで受け付けない。

実行前に親run `jev-q5-20261013132506165-0e6709af-b034-4ce7-8615-440183b07ae6` とcontinuation `jev-q5-20261013133540578-e4439186-1982-40ff-8470-e46f684966e7` のファイル集合とsymlink有無、manifest/config/run-lock/lineage/continuation-lock/attempt marker、A〜F全artifactを照合する。成功済みA/Dはresponse snapshotのhash・payload・raw score・正規化score・usage costまで照合する。各対象B/C/E/Fはsource artifactで`failed`、`attempts=1`、score/probabilities null、response null、cost unknownであることを要求し、pilot入力とのHMAC fingerprintも一致させる。既存run/artifactは変更せず、`.local/jev-q5-score-gap-runs/invalid-response-retry-v3/`以下に専用run・claims・attemptsを新規作成する。排他claimには対象ID・request cap・retry数・config/manifest hashを保存する。二重起動やdispatch後の中断は再送せず失敗扱いにする。今回発生したrun directory作成前の既知のpre-dispatch claimに限り、同一allowlist/cap/retry設定でありrun/attempt/response artifactが一切ないことを照合して、元claimのrun IDを保ったまま設定hashを結び直して復旧した。API responseを受信して形式不正だった場合は失敗artifactを残して次のallowlist対象へ進む。dispatchが曖昧でresponseを受け取れなかった場合はそこで停止しclaimを保持する。

実行結果: 2026-10-13に上記コマンドを実行し、retry用の別runからB/C/E/Fへ各1 requestを追加dispatchした（合計4 request、retry run内retry 0）。run IDは`jev-q5-invalid-retry-20261013142609999-42dc70db-f388-480b-bd73-5e100d36c727`で、pre-dispatch claimにあったrun IDと一致する。artifact pathは`.local/jev-q5-score-gap-runs/invalid-response-retry-v3/runs/jev-q5-invalid-retry-20261013142609999-42dc70db-f388-480b-bd73-5e100d36c727/`。

### v3-01 failed response の第2回限定再試行（実行完了・履歴）

「更に再試行」の指示に基づき、第1回retry後も有効scoreがないB/C/Fだけを対象とする専用CLI `pnpm tsx scripts/run-jev-q5-pilot.ts --retry-invalid-v3-round2` を実行した。対象はB=`q5-pilot-answer-b`、C=`q5-pilot-fixture-c`、F=`q5-pilot-fixture-f`、`maxRequests=3`、retry 0。成功済みA/D/Eは除外し、従来の`--retry-invalid-v3` claimとrun/artifactを含む過去artifactは変更していない。
実行前に初回parent `jev-q5-20261013132506165-0e6709af-b034-4ce7-8615-440183b07ae6`（2 request）、continuation `jev-q5-20261013133540578-e4439186-1982-40ff-8470-e46f684966e7`（4 request）、第1回retry `jev-q5-invalid-retry-20261013142609999-42dc70db-f388-480b-bd73-5e100d36c727`（4 request）の3 sourceを検証した。manifest/config、lineage、artifact schemaと値、response snapshot hash、claim/attempt marker、入力HMACを照合し、第1回retryのB/C/Fがfailed・score null・unknown cost、Eがsucceededであることを要求した。source artifactはfailureKindを保持しないため、`invalid_response`の根拠はoperation historyに限られる。lineageにはsource run ID、各sourceのrequest数（2/4/4）、累積10 dispatch、第1回retryの4対象・成功したE・残るB/C/F、round2の対象数と設定を記録した。
第2回retryは`.local/jev-q5-score-gap-runs/invalid-response-retry-v3-round2/`の独立した排他claim/run/attempt namespaceを使用した。B/C/Fはfailed artifactとなりscoreおよびusage/costは不明だった。operation historyの`invalid_response`分類だけでは正確なfailure kindを検証できない。3 requestすべてresponseを受信したためallowlistを完走し、ambiguous dispatchによる停止はなかった。run IDは`jev-q5-invalid-retry-round2-20261013143859119-b2e07787-228c-4d17-bff5-c69a066366c3`、artifact pathは`.local/jev-q5-score-gap-runs/invalid-response-retry-v3-round2/runs/jev-q5-invalid-retry-round2-20261013143859119-b2e07787-228c-4d17-bff5-c69a066366c3/`。
round3完了直後・round4前の歴史スナップショット: 初回6 + 第1回retry 4 + 第2回・第3回retry各3で累計16 dispatch（各run retries=0）。当時の有効scoreはA/D/Eの3件、既知usageは3,117 input / 54 output tokens、known cost subtotalはUSD 0.000130914。failed response 13件のusage/costは不明で、実費合計も不明だった。round4完了後の現在値は累計19 dispatch、6件すべてに有効score、累積known cost subtotal USD 0.000262416（実費合計は歴史的failed responseのunknown costにより不明）。USD 0.01は費用上限ではない。

### v3-01 failed response の診断付き第3回限定再試行（完了・履歴）

実行コマンド `pnpm tsx scripts/run-jev-q5-pilot.ts --retry-invalid-v3-round3` を2026-10-14に実行した。実行前に既存の初回run、continuation、第1回retry、第2回retryのsource lineage/artifact検証を完了。round2 artifactで失敗が確認されたB=`q5-pilot-answer-b`、C=`q5-pilot-fixture-c`、F=`q5-pilot-fixture-f`のみを対象とし、A/D/Eは除外した。最大3 request、run内retry 0、対象ごとに1 dispatch。run IDは `jev-q5-invalid-retry-round3-20261013150248672-bfe66de4-08ec-4f0f-b470-b8cf0ad88fdb`、artifact pathは `.local/jev-q5-score-gap-runs/invalid-response-retry-v3-round3/runs/jev-q5-invalid-retry-round3-20261013150248672-bfe66de4-08ec-4f0f-b470-b8cf0ad88fdb/`。

各受信responseはbodyを一度だけtextとして読み、HTTP status、正規化したcontent type、UTF-8 body byte length、body SHA-256を `runs/<runId>/diagnostics/<index>.json` に記録する。body本文、answer text、secret、tokenは診断・artifact・ログへ保存しない。JSON parse失敗は `json_parse_error`、strict schema/predicate rejectは `validator_rejection` とし、診断には固定code/path、型名、schemaで要求される静的key名のうち欠けたもの、余分なkeyの件数、該当する場合は確率合計/加重scoreとの差分を記録する。更新済みrunnerが今後作成するdiagnostic-v2 sidecarでは、数値が安全に算出できる場合、`returnedScore`、`weightedScoreFromProbabilities`、`weightedScoreDelta`、`probabilitySumDelta`も数値のみ保存する。body read failureではHTTP status/content typeを保持し、body SHA-256とbyte lengthはnullとなる。この場合は診断sidecarだけを保存し、failed score artifactを作らず、その場で停止して次のrequestを送らない。HTTP非成功、parse rejection、validator rejectionは受信済みresponseの診断とfailed artifactを保存して次の対象へ進む。transport/ambiguous dispatchまたはローカル保存失敗も停止する。weighted-score consistency checkの上限0.02はinclusiveで、浮動小数点境界用epsilon `1e-12`だけを加える。これにより境界付近の丸め誤差を許容し、約0.08のdeltaの拒否は変えない。

diagnosticsはrunごとのappend-only sidecarであり、既存artifact schemaおよび過去run/claim/operation historyは変更しない。診断sidecarもrun artifactと同じowner-only local run領域に0600 file / 0700 directoryで保持する。保持期間は当面、対応するpilot artifactの保管期間と同一（local-only、期間未設定）とし、後日削除する場合も旧artifactを書き換えずsidecar単位で扱う。round3では3件すべてHTTP 200 / `application/json`を受信したが、当時のvalidatorが3件とも `weighted_score_delta` で拒否した。Bのdeltaは0.020000000000000462で、上限0.02を約4.6e-16だけ超えたため、浮動小数点境界由来の可能性が高い。現在の1e-12 epsilonならBは境界内として通る。C/Fはそれぞれ0.08000000000000007 / 0.07999999999999985で、上限を約0.06超えるため引き続き拒否される。round3の診断v1には返却score/確率の加重scoreが保存されておらず、過去の失敗response本文も保持しないため、これらの数値は遡及復元できない。round3のscore、usage、costはunknownで、ambiguous dispatchはなく3件を完走した。

| 答案ID | HTTP / content type      | body SHA-256                                                       | bytes | 診断code / path                                                                    | score・usage・cost  |
| ------ | ------------------------ | ------------------------------------------------------------------ | ----: | ---------------------------------------------------------------------------------- | ------------------- |
| B      | 200 / `application/json` | `dd41ba20bcf265efe025acfb25512ba3a16df05d1cb6b0ce0ce134d7b9b4b7b2` |  1217 | `weighted_score_delta` / `answers.answer_match.score` (delta 0.020000000000000462) | scoreなし / unknown |
| C      | 200 / `application/json` | `377ae1e11ec330e96f2db4b7df4999177458aaf309a3eb51705b66c40da86873` |  1215 | `weighted_score_delta` / `answers.answer_match.score` (delta 0.08000000000000007)  | scoreなし / unknown |
| F      | 200 / `application/json` | `2aa7cf1e662c90c48b636dfa20578a5578ea5cc25088c3063c167cef6c94017b` |  1216 | `weighted_score_delta` / `answers.answer_match.score` (delta 0.07999999999999985)  | scoreなし / unknown |

### v3-01 initial passと4回の限定retry結果（履歴）

| 答案ID | 初回pass                 | retry 1 / retry 2 / retry 3 / round4                                                                                         | JEV結果（raw / 9） |   score01 | 問題オーナー手動評定（0–9、別基準） | usage / known cost                       |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -----------------: | --------: | ----------------------------------: | ---------------------------------------- |
| A      | succeeded                | — / — / —                                                                                                                    |               6.27 | 0.6966667 |                                   2 | 1,027 input / 18 output; USD 0.000043134 |
| B      | failed (kind unverified) | failed (kind unverified) / failed (kind unverified) / `weighted_score_delta` / succeeded (warning delta 0.0600000000000005)  |               7.47 |      0.83 |                                   6 | 1,039 input / 18 output; USD 0.000043638 |
| C      | failed (kind unverified) | failed (kind unverified) / failed (kind unverified) / `weighted_score_delta` / succeeded (warning delta 0.08999999999999986) |               8.17 | 0.9077778 |                                   7 | 1,049 input / 18 output; USD 0.000044058 |
| D      | succeeded                | — / — / —                                                                                                                    |               1.65 | 0.1833333 |                                   5 | 1,045 input / 18 output; USD 0.00004389  |
| E      | failed (kind unverified) | succeeded / — / —                                                                                                            |               5.91 | 0.6566667 |                                   8 | 1,045 input / 18 output; USD 0.00004389  |
| F      | failed (kind unverified) | failed (kind unverified) / failed (kind unverified) / `weighted_score_delta` / succeeded (warning delta 0.05999999999999983) |               1.23 | 0.1366667 |                                   2 | 1,043 input / 18 output; USD 0.000043806 |

問題オーナー手動評定2,6,7,5,8,2は暫定labelで、JEV scoreとは別基準・別列として保持する。v3-01で合計19 dispatch（初回6 + 第1回retry4 + 第2回・第3回・第4回retry各3）。B/C/Fは各4回failedした後、round4でweighted-score consistency checkを無効にして成功。先行3回のfailure kindは未検証だが、round3のreject理由はsidecarでweighted-score deltaのみと確認した。Eは初回failed後に第1回retryで成功した（初回failure kind未検証）。ユニーク答案6件すべてに有効scoreがあるが、pilotのみで意味充足評価の妥当性や順位一致の結論は出せない。有効応答6件のusage合計は6,248 input / 108 output tokens、known cost subtotalはUSD 0.000262416。failed response 13件のusage/costは不明なので実費合計は不明。初回passだけのknown subtotalはUSD 0.000087024で、累積known subtotalと区別する。

**failure reasonの来歴制約:** source artifactはfailureKindを保存しておらず、それ自体が特定のinvalid response理由を証明するものではない。先行roundのoperation historyには`invalid_response`というラベルがあるが、response body・predicate診断が保存されていないため正確なfailure kindは未検証である。各回のCLIはsource artifactのfailed状態/null score/unknown costを検証して対象を決めた。round3だけは別sidecarにvalidator code/pathとweighted-score deltaを記録した。failed responseの返却scoreや確率は過去artifactに残っていないので、遡及して算出できない。

### v3-01 failed response のweighted-score rejection無効化による第4回限定再試行（完了・履歴）

実行候補コマンドは `pnpm tsx scripts/run-jev-q5-pilot.ts --retry-invalid-v3-round4`。この専用モードはB=`q5-pilot-answer-b`、C=`q5-pilot-fixture-c`、F=`q5-pilot-fixture-f`だけに固定され、最大3 request、run内retry 0、対象ごとに最大1 dispatchとする。通常のrecord selection引数は受け付けない。A/D/Eは先行runで有効scoreを得ているため再送対象に含めない。

このroundだけ `weighted_score_delta` をresponse rejection条件から一時的に外す。returned score、確率から算出したweighted score、および両者のdeltaはround4 diagnosticに数値メタデータとして記録し、deltaが0.02を超えたときもwarningとして記録する。raw response bodyは保存しない。JSON parse、strict response schemaと必須key、type、score 0〜9、confidence 0〜1、各probability 0〜1、probability sum delta 0.02以内の検証は引き続き必須で、これらに違反したresponseは引き続きrejectする。成功artifact自体のschemaと `score01 = rawScore / 9` 検証も維持する。

dispatch前に初回parent、continuation、第1回retry、第2回retryのsource検証を再実行し、round3専用claim/config/manifest/lineage/attempt marker、B/C/F各round3 artifactとdiagnosticも照合した。round3のB/C/Fが`weighted_score_delta`だけによるvalidator rejectionだったこと、A/D/Eが先行lineage上で成功済みであることを確認した。round4は `.local/jev-q5-score-gap-runs/invalid-response-retry-v3-round4/` に専用claim・attempt・run namespaceを作成し、全source run IDとround4前の累積16 dispatchをlineageへ記録した。排他claimがある場合に再実行しない方針は維持する。response rejection後は受信済みresponseの診断とfailed artifactを保存して次の対象へ進み、ambiguous dispatch、body read failure、local保存失敗では停止してclaimを保持する。

実行結果: 2026-10-13 UTCに上記コマンドを1回実行し、3 requestすべてresponseを受信して成功artifactを保存した。run ID `jev-q5-invalid-retry-round4-20261013221312643-4f8e4eeb-228a-4623-9648-73d55b5b1eec`、artifact path `.local/jev-q5-score-gap-runs/invalid-response-retry-v3-round4/runs/jev-q5-invalid-retry-round4-20261013221312643-4f8e4eeb-228a-4623-9648-73d55b5b1eec/`。Bは7.47/9（score01 0.83）、returned score 7.47、probability-weighted score 7.53、delta 0.0600000000000005。Cは8.17/9（0.9077778）、weighted score 8.26、delta 0.08999999999999986。Fは1.23/9（0.1366667）、weighted score 1.1700000000000002、delta 0.05999999999999983。3件ともprobability sum deltaは0で、weighted-score deltaは各diagnosticにwarningとして記録された。usage/costはB 1,039 input / 18 output tokens・USD 0.000043638、C 1,049 / 18・USD 0.000044058、F 1,043 / 18・USD 0.000043806で、known subtotalはUSD 0.000131502。raw response body、answer text、secretは保存せず、round1〜round3 artifactとclaimは変更していない。

当時のv2 runnerは保存直前にschemaと同等のstrict artifact構造を検証し、成功runは`score100`が`rawScore * 50`と浮動小数点epsilon内で一致することもassertしていた。Schemaはstatusに応じて値の有無を制約する。`succeeded`ではprovider実model ID、3値のprobabilities、raw score、response参照とhashが必須でnon-null。`failed`/`incomplete`ではprovider呼出し前失敗などで未取得値をnullにでき、取得済みの値は保持してよい。当時のv2（raw 0–2）集計前semantic validationでは、成功runの確率合計を1から0.02以内、かつ `rawScore` と `p0*0 + p1*1 + p2*2` の差を0.02以内としていた。これは旧v2 runner用の許容差で、現行adapterのweighted-score検査を表すものではない。現行adapterではweighted-score mismatchはwarningとして記録し、reject条件にしない。response shape、type、score/probability範囲、probability sumの検証は維持する。

## 5. 実施状況

- 旧run時に完了: 6件の入力と問題オーナー暫定humanラベルをlocal-only dev pilotへ保存。個別答案・ID・ラベル対応はlocal-onlyに限定。human 0–9とJEV raw 0–2は別尺度。これはP0の部分着手であり、基準や評価セットの完了ではない。
- 完了: 旧rubricの凍結6件API採点は6/6成功。14 pairで9 concordant / 5 reversed / 0 model ties（64.3%）。これは旧semantic-match基準に対する暫定集計。retry・production DB writeなし。
- 完了: fulfillment rubric v2で6 requestの再採点を実施し6/6成功。native raw scoreと100点換算を保存し、旧runとのsupersedes linkおよび保存前artifact構造/換算式検証を確認。
- 完了（dispatch）/ 結論不能（評価）: 旧prompt rubric v3-01で初回pass 6件、第1回限定retry 4件、第2回〜第4回限定retryを各3件、累計19 dispatchを完了した（各run retries=0）。これらはv3-01 score履歴で、v3-02の実行結果ではない。A=6.27/9（0.6966667）、B=7.47/9（0.83）、C=8.17/9（0.9077778）、D=1.65/9（0.1833333）、E=5.91/9（0.6566667）、F=1.23/9（0.1366667）。A/Dは初回成功、Eは初回failed後に第1回retryで成功、B/C/Fはround3でweighted-score deltaのみを理由にrejectされた後round4で成功。failed response 13件は過去round分でusage/cost unknown。全6成功responseのusage合計は6,248 input / 108 output tokens、known cost subtotalはUSD 0.000262416、実費合計は不明。round3 run `jev-q5-invalid-retry-round3-20261013150248672-bfe66de4-08ec-4f0f-b470-b8cf0ad88fdb`およびround4 run `jev-q5-invalid-retry-round4-20261013221312643-4f8e4eeb-228a-4623-9648-73d55b5b1eec`のartifact pathと結果は上記参照。ユニーク6件すべてに有効scoreがあるが、pilotのみでfull validation/adoptionは結論不能。API comparisonは実施しない。
- 完了（実装）/ 未実施（API・評価）: current rubric v3-02をpilot runnerとproduction adapterに同期。question/ref不変、同一指示、0–9 raw/9。v3-02 API runなし。旧v3-01 artifacts/scoresを保持し、現行assessment/aggregation pairとして受け入れない。adoption未実施。
- 完了: fulfillment-v2で `q5-pilot-fixture-e` だけを `--record-ids q5-pilot-fixture-e --max-requests 1` により1 request、retry 0で再採点。run `jev-q5-20261013111546479-51d41c4d-1dc1-4643-83f1-97b02a4cc821`、supersedes `jev-q5-20261013110343293-c93b0fea-3796-4310-9c3d-2c5ab5e7891f`。raw 0.83/2、score100 41.5（前回v2の41.5から変化なし）、usage 802 input / 18 output tokens、known cost USD 0.000033684。
- 未実施: 中間アンカー定義、独立評者はpilotで一時省略（full validation/adoption前に必要性を再検討）、不一致裁定、十分なdevセットと独立untouched validationの作成・分離・凍結/hash、ordinal-ranking primary metricのデータ要件/不確実性評価、untouched validation、採用判断。baseline/candidate API比較は実施しない。費用上限はユーザー指定なし。USD 0.01 post-response guardはエージェント選択の二次停止条件で発火せず、spend capではない。Binary thresholdは設定せず、目的にも含めない。
- 既提示のA/Bはuntouched validationに使用しない。sh7/sh9のJEV score/confidenceはgold labels/dataに含めない。
- 追加で必要な対話: 中間anchorの粒度、独立評者の必要性再検討、追加実例と件数の方針（上記参照）。
- 実行結果（v3-01履歴）: 初回6 dispatchと限定retry 4 + 3 + 3 + 3 dispatchを記録済み。累計19 dispatchでユニーク6件すべて有効scoreを取得。v3-02 API runはなく、full validation/adoptionの判断は`[未実施]`。

#### sh7 read-only DB照合

照合条件: `normalized_name = 'sh7'` または `display_name = 'sh7'` 完全一致かつ `question_key = 'it-literacy-005'`。1 rowで、submission/assessment revision `1/1`、question/rubric version `tamami-egg-v1/tamami-egg-v1`、model `jev-1.13.0`、state `graded`、raw/normalized score `1.42/0.71`、confidence `0.35`、attempts `1`、error_code nullを取得した。旧0–2尺度のraw/2値であり現行v3とはrubric versionが異なるため比較しない。回答本文・participant IDは取得しておらず、DB更新・採点もしていない。sh9は未確認。
