# shared-plan35 発表操作レイテンシ実測

## 比較条件

| 項目         | 条件                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| baseline     | Git HEAD `32b29c1`                                                       |
| current      | 計測時点の未コミット tree                                                |
| 依存関係     | 両方で同一の `node_modules`                                              |
| アプリ       | localhost の webpack dev server。baseline は `:3002`、current は `:3001` |
| ブラウザー   | Chromium                                                                 |
| HTTP         | 操作に関係する mock 応答に 50 ms の delay                                |
| browser 操作 | 各操作 10 回                                                             |
| DB 操作      | 各 action 40 回、local file-backed fixture                               |

値はミリ秒単位で、`p50 / p95` の順に記載する。browser の測定器は `scripts/measure-presentation-latency.mjs`、DB の測定器は `tests/db/presentation-latency.bench.ts`。

## Browser 操作

### 次の操作が受理されるまで

入力後に逆方向操作を 12 ms 間隔で試し、2 回目の POST が始まった時点を次の操作の受理 proxy とした。

| 操作             | baseline p50 / p95 | current p50 / p95 |
| ---------------- | -----------------: | ----------------: |
| キーボードで進む |      210.4 / 218.8 |      91.5 / 108.3 |
| キーボードで戻る |      210.0 / 220.0 |      89.6 / 101.9 |
| クリックで進む   |      214.0 / 223.5 |      95.9 / 113.3 |
| スワイプで進む   |      295.3 / 313.6 |     179.7 / 192.4 |
| スワイプで戻る   |      304.4 / 314.9 |     190.5 / 196.0 |

### DOM 更新後の 2 回の animation frame まで

入力から DOM mutation を検知し、その後 2 回 `requestAnimationFrame` が呼ばれるまでを測定した。

| 操作             | baseline p50 / p95 | current p50 / p95 |
| ---------------- | -----------------: | ----------------: |
| キーボードで進む |        19.2 / 26.6 |       19.1 / 26.5 |
| キーボードで戻る |        17.7 / 23.5 |       17.3 / 24.2 |
| クリックで進む   |        15.9 / 26.9 |       15.9 / 26.5 |
| スワイプで進む   |      110.2 / 120.9 |     109.5 / 119.6 |
| スワイプで戻る   |      113.4 / 121.9 |     118.5 / 126.9 |

各 warm 操作の POST 数は baseline、current ともに 1 回。POST wait は両方で約 56–60 ms。baseline では計測 window 内の session GET、controls GET の count はそれぞれ p50 / p95 ともに 1 / 1、wait は約 55–60 ms。current では両 GET とも count の p50 / p95 が 0 / 0 だった。GET は定期 poll が計測 window と重なった可能性があるため、操作に起因するリクエスト数とは断定できない。

## Cold load 参考値

deck GET は両方で約 57 ms。navigation 開始から DOM 更新後 2 animation frame までの値は baseline 1149 ms、current 1130 ms。各 1 回のみの参考値であり、p50 / p95 ではない。

## DB 操作

Drizzle が記録した SQL statement 数/操作と、local fixture 上での操作時間を記載する。baseline は full 操作、current は controls 操作の実装を計測した。

| Action   | SQL 数 baseline full → current controls | baseline p50 / p95 (ms) | current p50 / p95 (ms) |
| -------- | --------------------------------------: | ----------------------: | ---------------------: |
| start    |                                 18 → 15 |         2.8535 / 3.9065 |        2.1105 / 2.8727 |
| advance  |                                  10 → 7 |         1.8238 / 2.9605 |        1.3711 / 1.5985 |
| previous |                                  10 → 7 |         1.7565 / 2.8991 |        1.3096 / 1.4262 |
| hide     |                                  10 → 7 |         1.7249 / 2.0230 |        1.4285 / 1.6947 |
| show     |                                  10 → 7 |         1.7240 / 1.8746 |        1.3895 / 1.5813 |
| replay   |                                   8 → 5 |         1.5067 / 1.7155 |        1.1681 / 1.3604 |

## 再実行

両 tree を同じ Node.js / `node_modules` で使い、baseline と current の webpack dev server をそれぞれ `localhost:3002`、`localhost:3001` で起動する。両方に同じ管理者 PIN 設定を使う。各 server の起動コマンドは次のとおり。

```sh
pnpm exec next dev --webpack --port 3002
pnpm exec next dev --webpack --port 3001
```

browser 計測は各 server に対して実行する。10 回・50 ms delay を明示した例:

```sh
BASE_URL=http://localhost:3002 PRESENTATION_BENCH_SAMPLES=10 PRESENTATION_BENCH_DELAY_MS=50 node scripts/measure-presentation-latency.mjs
BASE_URL=http://localhost:3001 PRESENTATION_BENCH_SAMPLES=10 PRESENTATION_BENCH_DELAY_MS=50 node scripts/measure-presentation-latency.mjs
```

DB 計測は各 tree で同じ fixture を使って実行する。baseline には現行の benchmark file を一時的に配置して実行する。benchmark は action ごとに 40 回実行し、集計 JSON を stdout に出力する。

```sh
pnpm exec vitest bench tests/db/presentation-latency.bench.ts
```

## 読み取り上の制約

- 次の操作受理時間は、12 ms 間隔の逆入力 probe に対する 2 回目の POST 開始を使った proxy 値で、内部の mutation unlock 時刻そのものではない。
- DOM 更新後 2 animation frame は描画完了を保証しない。
- session / controls GET は計測 window 内の定期 poll が含まれ得る。
- cold load は `n=1` の参考値。
- DB は Drizzle SQL 数と local file-backed fixture 上の操作時間であり、本番データベースの実測値ではない。
- HTTP delay は mock 応答に設定した値。結果には HTTP wait の実測値を含む。
- この報告には数値、条件、操作名のみを記載し、fixture の個人情報・secret・request/response body は含めない。
