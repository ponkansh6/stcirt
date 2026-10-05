# 参加者認証の必須環境設定を簡素化する計画

## 目的

参加者ログインで必須となっている `PARTICIPANT_PIN_HASH`、`PARTICIPANT_PIN_PEPPER`、`PARTICIPANT_SESSION_SECRET`、`PARTICIPANT_EVENT_VERSION` の4設定を簡素化する。ログイン後のセッションは参加者識別と有効期限・失効判定に必要な情報を保持し、回答の閲覧機能もないため、複雑なPINハッシュ管理や手動version更新をなくす。一方で、回答を他人の参加者IDに紐づけられないよう、セッションCookieの署名は維持する。

## 現状

- 参加者認証ではPINハッシュ、PIN用pepper、Cookie署名用secret、Cookie失効用event versionを別々に設定する必要がある。
- 4桁の共通PINは候補数が10,000通りであり、pepperを加えたハッシュでも強い本人確認にはならない。
- 現在のCookie payloadは `{ id, exp, version }` で、回答ログは参加者IDに紐づく。ログイン後のセッションは参加者識別と有効期限・失効判定に必要な情報を保持するが、特段センシティブな情報は保持しない。
- セッションCookieの署名は、Cookie payloadの改ざんによる他人のID偽装を防ぐために必要である。

## 推奨決定

必須設定を次の2つにする。

| 設定 | 役割 |
| --- | --- |
| `PARTICIPANT_PIN` | ASCII数字4桁の催し共通PIN。先頭の0を許可し、平文はサーバー環境設定だけに置く |
| `PARTICIPANT_SESSION_SECRET` | 既存の32 byte以上の高entropyな独立秘密。Cookie署名鍵とレート制限鍵の導出元にする |

`PARTICIPANT_PIN_HASH`、`PARTICIPANT_PIN_PEPPER`、`PARTICIPANT_EVENT_VERSION` は廃止する。`PARTICIPANT_PIN` とsecretは `NEXT_PUBLIC_` 設定にせず、クライアントbundle、ログ、Cookieにも出さない。

名前と共通PINによる参加方式を続けることは、この計画を具体化するための**未回答の作業仮定**であり、ユーザー承認済みの要件ではない。確認後に異なる方式が必要と分かった場合は、この前提を置き換える。

必須設定を1つにする案も検討した。PINだけを元に署名鍵を作ると10,000候補を試せるため、偽造Cookieを作られるおそれがある。起動時にランダムな秘密を生成する方式は再起動でCookieが失効し、複数instance間で鍵が一致しない。DBのopaque session方式はセッションテーブル、保存、期限切れデータの掃除を増やす。この簡素化の目的には採用せず、1設定への削減が必須であれば別案へ切り替える。

## 設計

- PINは入力値と `PARTICIPANT_PIN` の両方をASCII数字4桁として厳密に検証し、既存のcrypto機能による一定時間比較で照合する。設定が欠落または不正、あるいは入力が不正・不一致ならfail closedとする。先頭0を保持する。
- Cookie payloadを `{ id, exp }` に簡素化する。署名鍵は `HMAC-SHA256(PARTICIPANT_SESSION_SECRET, 用途識別固定文字列 + 区切り + PARTICIPANT_PIN)` で導出する。用途識別ラベルと区切りは固定し、互換性に関わる仕様として文書化する。
- 署名鍵の導出に低entropyのPIN単独を使わない。PIN変更または `PARTICIPANT_SESSION_SECRET` 変更で署名鍵が変わり、既存Cookieは自動失効するため `PARTICIPANT_EVENT_VERSION` は不要となる。
- レート制限用HMAC鍵は同じmaster secretから別の固定用途ラベルで導出する。PINを導出入力に含めず、PINを変更しても同じレート制限鍵を使う。PIN変更だけで試行制限がリセットされないことをテストで確認する。
- 起動時に自動で秘密を生成しない。必要な環境設定がなければ認証を拒否する。
- HttpOnly、SameSite=Lax、productionでSecure、適切なPathと期限を持つCookie、Origin検査、DBでの参加者存在照会、DB共有の5回/15分レート制限を維持する。任意の `PARTICIPANT_SESSION_DAYS` と `PARTICIPANT_RATE_LIMIT_NAME` 設定も現行どおり維持する。
- 既存参加者と回答は保持する。API request/response、UI、DB schemaに変更を加えない。旧形式Cookieは移行時に失効させて再ログインとし、旧形式へのfallbackは設けない。新コードでは廃止envを参照しない。

## 実装手順

1. 実装前にリポジトリから解決される `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md` と `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` を読み、現行Next.jsのCookie・Route Handler仕様を確認する。
2. `src/lib/participants/security.ts` の環境設定検証、PIN照合、セッションpayload/署名鍵導出を変更し、rate-limit連携で独立ラベルの鍵導出とPIN非依存性を保つ。
3. `src/app/api` のsession/answers routeは現在のrequest/response契約を保ち、署名済みCookie、参加者照会、Origin検査、レート制限の動作を維持する。
4. `scripts/generate-participant-pin-hash.mjs` を撤去し、参照箇所を検索して取り除く。env検証の `check-env` 関連に古い必須条件があれば新しい2設定へ合わせる。
5. `scripts/manage-participant-auth.mjs` と `pnpm participant-auth` scriptを追加し、後述のローカル生成・Vercel同期手順を単一入口で提供する。Vercel CLIは固定バージョンのdevDependencyとして追加する。
6. `README.md` と `.env.local.example` の設定・運用手順を、ローカルで生成したPIN/secret pairの保存とVercelへの対象指定同期に合わせる。実運用のPIN/secretを公開文書に載せず、設定例ではダミー/placeholderを使う。
7. `openspec/specs/stcirt/spec.md` のRequirements/API/env設定を実装に同期する。特に既存のenv設定記述（43–46、94–106、132行付近）を確認し、旧設定、Cookie payload、失効方法、fail-closed動作、pairの生成・同期運用を更新する。行番号は編集時点の実ファイルで再確認する。
8. 必要箇所として `tests/participants/security.test.ts`、`tests/participants/rate-limit.test.ts`、`tests/participants/session-route.test.ts`、`tests/api/participants/session.test.ts`、`tests/api/answers.test.ts` と認証設定scriptのテストを更新する。
9. DB migrationは行わない。既存の参加者と回答レコードをそのまま保持する。

## ローカル生成とVercel同期

運用者がローカルでPINと署名secretのpairを生成し、同じ保存済みpairを明示したVercel環境へ同期する。生成と同期は `scripts/manage-participant-auth.mjs` を単一入口とし、例として `pnpm participant-auth generate`、`pnpm participant-auth sync --target production` を提供する。Preview/Developmentへの同期も `--target preview` / `--target development` のように明示し、全環境を暗黙に変更しない。通常のPreview対象は全branchであり、branch-specific overrideが存在する場合は検出して案内し、指定なしに対象範囲を広げない。

- `generate` はPINを `crypto.randomInt(0, 10000).toString().padStart(4, '0')` で作り、secretを `randomBytes(32).toString('base64url')` で作る。一度保存したpairは同期再試行にも使う。片方でも設定済みなら上書きを拒否し、変更は `pnpm participant-auth generate --rotate` の明示時だけ許可する。旧PIN hashからPINを復元せず、新しく生成したPINを運用者が参加者へ案内する。
- 保存先はgitignore済みの `.env.local` とする。既存のTurso等ほかの設定を保ち、この2キーだけをupsertする。既存ファイルは0600にし、一時ファイルも0600で作ってatomic renameで保存する。secretはstdoutやログへ出さない。参加者へ配布するPINだけは対話端末で表示できるようにし、自動実行ログには出さない。
- `sync` は `.env.local` の2値を読み、形式を検証するだけで、新規生成やrotateをしない。linked `.vercel/project.json`、Vercel CLIの可用性・認証、明示targetを事前確認し、project名とtargetを表示する。CLIの固定バージョンと利用方法を実装時にVercel公式ドキュメントで再確認する。
- CLIの既存loginを使い、token取り扱いを増やさない。秘密の2値はstdinで渡し、shell引数、shell履歴、表示出力へ含めない。既存環境変数も同期できるよう、公式CLIのupsert `vercel env add NAME TARGET --force --sensitive` を使い、Production/Preview/Developmentのすべてでsensitive設定にする。CLIのstdout/stderrはrawの値を出さず、終了コード、変数名、マスク済みエラーなど必要な状態だけを報告する。
- 2値の同期にtransactionはない。片方でも失敗すれば非zeroで終了し、同期成功として扱わない。同じ保存済みpairで再実行すれば状態を揃えられる。sync自体はdeployを起動せず、2値の反映成功後に新しいdeployが必要と案内する。Vercel環境変数の変更は既存deployに遡及しないため、同期中はGit連携による自動deployを含め新しいdeployを走らせない。
- 自動テストはmock CLIで行う。今回は文書の追記のみでVercelへの書き込みは行わない。

参考: [Vercel CLI env](https://vercel.com/docs/cli/env)、[Vercel CLI project linking](https://vercel.com/docs/cli/project-linking)、[Vercel environment variables](https://vercel.com/docs/environment-variables)。公式CLI docsで確認した `--force` によるupsertと、全targetでの `--sensitive` を用いる。実装時にもflagsを再確認する。

## 移行

- 旧 `PARTICIPANT_PIN_HASH` からPIN平文は復元できない。新規設定は `pnpm participant-auth generate` でpairを作り、表示されたPINを運用者が参加者へ案内する。移行時に既存 `.env.local` に `PARTICIPANT_SESSION_SECRET` など対象キーがある場合、通常generateは上書きを拒否するため、意図的な更新として `pnpm participant-auth generate --rotate` を使い、その操作で既存ログインが失効することを認識する。既存session secretの再利用は別の選択肢として残し、通常フローで生成・同期するpairとは区別する。
- 生成したpairはローカルの `.env.local` に保存し、`pnpm participant-auth sync --target production` など対象を明示してVercelへ反映する。PINだけを変更する場合はsecretを再生成する必要はない。pairの同期はアプリの新2-env対応と組み合わせ、旧コードが動作中の環境に新しい設定だけを適用しない。
- 新コードの配備と新環境設定を組み合わせ、全instanceで設定を揃える。Vercelの設定反映後は新しいdeployを行う。更新中は自動deployも含めてdeployを止め、異なるpairを読み込んだdeployが混在しないようにする。
- 旧Cookieは新形式で検証できないため利用者は再ログインする。新deployの動作確認後、`PARTICIPANT_PIN_HASH`、`PARTICIPANT_PIN_PEPPER`、`PARTICIPANT_EVENT_VERSION` を環境から削除する。
- 旧コードへrollbackするときは旧3設定が必要となる。rollbackが必要な期間は切替後すぐに旧設定を破棄せず、戻し手順を運用者が保持する。

## 検証計画

- 正しいPIN、誤ったPIN、先頭0のPIN、missing/invalid PIN設定を確認する。
- secret欠落・不正・既存の最小長要件を満たさない設定を拒否し、自動生成しないことを確認する。
- Cookieの改ざん、期限切れ、旧形式を拒否し、PIN変更とsecret変更のどちらでも既存Cookieが失効することを確認する。
- rate-limit HMAC用途ラベルが署名鍵と分離され、PIN変更前後でrate-limit鍵が同じであることを確認する。
- Origin不正または無効Cookieによる回答を拒否し、DB参加者照会と既存5回/15分制限を確認する。
- ログイン、回答、ログアウトのsmoke testを行い、PIN/secretがclient bundle、ログ、Cookieへ出ないことを確認する。
- 認証設定scriptはPINが4桁で先頭0も保持されること、secret長、他の `.env.local` 値の保持、既存keyの上書き拒否、明示rotate、secret出力抑止、安全なfile保存を確認する。
- mock CLIで2値をstdinと明示targetでupsertし、再試行時に再生成しないこと、片側失敗でnonzero終了すること、deployを自動起動しないこと、preflight不成立時に拒否することを確認する。実Vercelへの書き込みは行わない。
- 実装段階の検証ゲートは `pnpm lint:fast`、`pnpm type-check:fast`、`pnpm format:check`、`pnpm test:coverage`、`pnpm security-check`、`pnpm check-env`、`scripts/check-spec-refs.sh` を実行する。該当するE2Eとproduction buildも確認する。
- テストの実装はfixer、テスト実行と検証ゲートはorchestratorが担当する。hookを迂回しない。
- **この計画の作成時点では実装変更とテスト実行を行わない。**

## 完了条件

1. ログインに必要なenvが `PARTICIPANT_PIN` と `PARTICIPANT_SESSION_SECRET` の2つだけで、pairをローカル生成し、targetを明示してVercelへ同期できる。
2. 旧3設定を参照せず、旧Cookieは拒否され、参加者は再ログインで新Cookieを得られる。
3. PINまたはsession secretの変更で既存Cookieが自動失効する。
4. PIN変更ではrate-limit用鍵が変わらず、署名鍵とrate-limit鍵の用途が分離されている。
5. 既存Cookie属性、Origin検査、DB参加者照会、共有レート制限、およびAPI/UI/DB契約が維持される。
6. README、環境設定例、specが実装およびpairの生成・同期運用と同期し、既存参加者・回答にDB変更がない。
7. 計画に定めたテストと検証ゲートが通過する。
