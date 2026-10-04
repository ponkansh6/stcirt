# 問題作成後の「難易度を上げて再作成」/「破棄」

## Context

`/create` で問題を生成すると、`POST /api/questions` が **その場で DB に保存し**、`create-form.tsx` は結果と 3 つのボタン（続けてもう1問作る / 問題を解きに行く / ホームへ）を出す。つまり **生成された瞬間に問題は確定** しており、「簡単すぎた」「これは要らない」と思っても取り消す手段がない。放置された問題はそのまま `/answer` の抽選プールに入る。

本変更で結果画面に 2 つのアクションを追加する。

| ボタン                   | 文字通りの挙動                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **難易度を上げて再作成** | 同じソーステキストから、1 段階上の難易度で問題を作り直し、**古い問題は DB から消える**。連打すると Lv が積み上がる（Lv1 → Lv5 が上限） |
| **破棄**                 | 生成された問題を DB から削除し、入力フォームに戻る。**DB に何も残らない**                                                              |

「文字通り」を担保するために外せない性質:

1. **再作成に失敗しても古い問題を失わない** — LLM 生成が先、DB 置換が後。
2. **再作成で問題が二重に残らない** — 新規 insert と旧削除を 1 トランザクションに入れる。
3. **難易度が上がったことがユーザーから見える** — Lv バッジを出す。見えないと「押しても何も変わらない」ボタンになる。

---

## 確定した設計判断

| 項目                     | 選択                                                    | 理由                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 再作成の実装場所         | 専用ルート `POST /api/questions/[id]/regenerate`        | クライアントで「POST 新規 → DELETE 旧」にすると、DELETE が失敗した／タブを閉じた瞬間に **旧問題が孤児として抽選プールに残る**。サイレントなデータ破損になる。サーバ 1 往復にすれば置換を原子的にできる                                          |
| DB 置換の原子性          | `db.transaction` 内で「新規 insert → 旧 delete」        | 既存 `createKnowledgeWithQuestion` / `deleteQuestion` と同じ `db.transaction` パターン。片方だけ成功する窓を作らない                                                                                                                            |
| LLM 呼び出しの位置       | **トランザクションの外**                                | `LLM_QUIZ_TIMEOUT_MS = 45s` × 最大 3 リトライ。この間 libSQL の write トランザクションを開きっぱなしにしてはいけない                                                                                                                            |
| ソーステキストの入手元   | 旧問題の `knowledge.sourceText` を**サーバで SELECT**   | 「再作成」は定義上「同じナレッジから」。クライアントに送り返させると改竄可能で、ペイロードも無駄。旧 `knowledge.title` もそのまま流用でき、`route.ts` のタイトル導出正規表現を複製せずに済む                                                    |
| 難易度の保持場所         | **クライアント state のみ**（DB に列を足さない）        | ボタンは生成直後の結果画面にしか存在せず、リロードで消えて構わない。列追加は drizzle マイグレーション + `Question` 型 + `/questions` 一覧 + 重み付けに波及する。**スキーマ変更は本計画の非目標**                                                |
| 難易度の上限             | `QUIZ_MAX_DIFFICULTY = 5`                               | 上限が無いと Lv99 のような無意味なプロンプトに到達する。上限到達時はボタンを `disabled` にして注記を出す（黙って無反応にしない）                                                                                                                |
| Lv1 のプロンプト         | **現行と 1 バイトも変えない**（ディレクティブ空文字）   | 既存 `tests/llm/prompts.test.ts` / `quiz.test.ts` がそのまま通り、通常作成パスの挙動・コスト・レイテンシが不変であることを保証できる                                                                                                            |
| 難易度 ≥2 のトークン上限 | `LLM_QUIZ_MAX_TOKENS_HARD = 1024`                       | 現行 512。難問は選択肢も解説も長くなり、**打ち切り → 不正 JSON → parse リトライ枯渇 → 500** がこの機能の最有力な実運用故障。通常パスの 512 は据え置いてコスト影響を封じ込める                                                                   |
| 破棄の確認ダイアログ     | **付けない**（`/questions` のインライン確認とは非対称） | 対象は数秒前に生成されたばかりで解答履歴ゼロ、かつ**ソーステキストは textarea に残す**ので「もう一度作る」で実質やり直せる。`/questions` 側の確認は、履歴が溜まった問題かつ入力テキストが復元不能だから必要だった。この非対称は spec に明記する |
| 破棄後の textarea        | **入力テキストを保持**、難易度は Lv1 にリセット         | 破棄したいのは「生成された問題」であってナレッジではない。文言を直して作り直せる。テキストを消したいケースは既存の「続けてもう1問作る」が担当（役割が重複しない）                                                                               |
| 破棄の API               | 既存 `DELETE /api/questions/[id]` を流用                | 挙動（問題 + knowledge + answerLogs を明示 cascade）が要件と完全一致。新規エンドポイント不要                                                                                                                                                    |
| 破棄ボタンの variant     | `danger`                                                | `cn()` はマージしないので `ghost` + `className="text-error"` は `text-muted` と衝突して CSS 順序勝負になる（`Button.tsx` のコメントが警告している罠）。既存の `danger` variant をそのまま使う                                                   |
| サーバでの「上げた」検証 | 範囲 `2..5` のみ検証（旧難易度との比較はしない）        | 難易度を永続化しない以上、サーバは現在値を知り得ない。クライアントが source of truth。これは**意図的な妥協**として明記する                                                                                                                      |

---

## 実装

### 1. `src/lib/constants.ts` — 難易度とトークン上限

```ts
// ── Quiz defaults ──
export const QUIZ_CHOICES_PER_QUESTION = 4;
export const QUIZ_MIN_DIFFICULTY = 1;
export const QUIZ_MAX_DIFFICULTY = 5;

// ── LLM ──
export const LLM_QUIZ_MAX_TOKENS_HARD = 1024; // difficulty >= 2 用
```

`LLM_QUIZ_MAX_TOKENS = 512` は変更しない。

### 2. `src/lib/llm/prompts.ts` — 難易度ディレクティブ

`QUIZ_GENERATION_PROMPT` に `{{DIFFICULTY}}` スロットを 1 つ足し、Rules の末尾に **難易度に関わらず守るべき制約**を追加する:

```
- The correct answer MUST be uniquely determinable from the provided text alone. Never require outside knowledge, even at high difficulty.
{{DIFFICULTY}}
```

この 1 行が無いと「難しくする」が「テキストから答えられない/幻覚」に退化する。難易度上げの最大のリスクなので共通側に置く。

```ts
export const DIFFICULTY_DIRECTIVES: Record<number, string> = {
  1: "", // 現行プロンプトと完全一致させるため空
  2: "- Difficulty: ... 用語の再認ではなく、適用・比較を問う ...",
  3: "- Difficulty: ... 複数概念を組み合わせた推論。誤答選択肢をもっともらしく ...",
  4: "- Difficulty: ... 例外・境界条件・落とし穴。表層的な言い換えでは正解できないように ...",
  5: "- Difficulty: ... 実務シナリオに埋め込み、複数ステップの推論を要求 ...",
};

export function buildQuizPrompt(sourceText: string, difficulty: number): string;
```

- `buildQuizPrompt` は `{{DIFFICULTY}}` → ディレクティブ、`{{SOURCE_TEXT}}` → 本文の順で置換。
- **置換順序が重要**: ソーステキストが先だと、ユーザー入力に `{{DIFFICULTY}}` という文字列が含まれていた場合にプロンプトインジェクションになる。必ず `{{DIFFICULTY}}` を先に埋める。
- 範囲外の `difficulty` は `DIFFICULTY_DIRECTIVES[1]` にフォールバック（`?? ""`）。
- Lv1 では `{{DIFFICULTY}}` 行が空文字に置換され、結果の余分な改行も除去して**現行プロンプトと文字列一致**させる（テストで assert する）。

### 3. `src/lib/llm/quiz.ts` — `difficulty` 引数

```ts
export async function generateQuestion(
  sourceText: string,
  difficulty: number = QUIZ_MIN_DIFFICULTY,
): Promise<GeneratedQuestion | null>;
```

- `buildQuizPrompt(sourceText, difficulty)` を使う。
- `maxTokens = difficulty >= 2 ? LLM_QUIZ_MAX_TOKENS_HARD : LLM_QUIZ_MAX_TOKENS`。
- デフォルト引数なので **既存呼び出し元（`POST /api/questions`）とテストは無変更で通る**。

### 4. `src/lib/db/repository/question-repository.ts` — 置換と読み出し

```ts
export interface QuestionSource {
  title: string;
  sourceText: string;
}
export async function getQuestionSource(questionId: number): Promise<QuestionSource | null>;
```

`questions` → `knowledge` を `innerJoin` して `title` / `sourceText` を返す。未存在は `null`（throw しない — `withErrorHandling` が 500 に変換してしまい 404 を返せなくなる）。

```ts
export interface ReplaceKnowledgeInput extends CreateKnowledgeInput {
  replaceQuestionId: number;
}
export async function replaceKnowledgeWithQuestion(
  input: ReplaceKnowledgeInput,
): Promise<{ knowledgeId: number; questionId: number } | null>;
```

1 つの `db.transaction` 内で:

1. 旧 `questions` から `{ id, knowledgeId }` を SELECT → 無ければ **`null` を返す**（step 2〜4 の間に他タブが削除したケース）。
2. 新 `knowledge` を insert。
3. 新 `questions` を insert（`questions.knowledgeId` は UNIQUE だが新 knowledge の id なので衝突しない）。
4. 旧を child → parent の順で明示削除: `answerLogs` → `questions` → `knowledge`。`PRAGMA foreign_keys` が有効化されていないため schema の `onDelete: "cascade"` は発火しない（プラン 14 と同じ理由）。

**旧 answerLogs は消える**。旧問題自体が消えるので当然だが、統計（`/` の本日の解答数）から履歴が減る点は spec に書く。

`createKnowledgeWithQuestion` の insert 部分はこの関数と重複するので、トランザクション内ヘルパー `insertKnowledgeAndQuestion(tx, input)` に括り出して両者から呼ぶ。

### 5. `src/lib/api/schemas.ts` — リクエストスキーマ

```ts
export const regenerateQuestionSchema = z.object({
  difficulty: z
    .number()
    .int()
    .min(QUIZ_MIN_DIFFICULTY + 1)
    .max(QUIZ_MAX_DIFFICULTY),
});
```

`min` が 2 なのは、ボタンが文字通り「難易度を**上げて**再作成」だから。Lv1 への再作成はこのエンドポイントの責務ではない。

### 6. `src/app/api/questions/[id]/regenerate/route.ts`（新規）

`[id]/route.ts` と同じく **Next 16 の `context.params` は Promise なので `await` 必須**（await せず `safeParse` すると全リクエストが 400 になる）。

```ts
export const maxDuration = 300; // 既存 POST /api/questions と同じ。LLM 生成を含むため必須
```

処理順:

| #   | 処理                                                     | 失敗時                                     |
| --- | -------------------------------------------------------- | ------------------------------------------ |
| 1   | `params` を await → `questionIdParamSchema`              | 400 `Invalid question id`                  |
| 2   | body → `regenerateQuestionSchema`                        | 400 `Invalid difficulty`                   |
| 3   | `getQuestionSource(id)`                                  | 404 `Question not found`                   |
| 4   | `generateQuestion(sourceText, difficulty)` ← **tx の外** | 500 `Failed to generate question from LLM` |
| 5   | `replaceKnowledgeWithQuestion(...)` → `null`             | 404 `Question not found`                   |
| 6   | `ok({...}, 200)`                                         | —                                          |

**step 4 で失敗しても旧問題は無傷** — これが「再作成に失敗しても失わない」の実体。

レスポンスは `POST /api/questions` と同一形状 `{ id, knowledgeId, question, choices, correctIndex, explanation }`。**201 ではなく 200**（新規作成ではなく既存リソースの置換であり、`Location` を返す性質でもない）。エラーメッセージは既存ルート同様に英語（日本語は UI 層）。

### 7. `src/lib/api/client.ts` — `regenerateQuestion`

```ts
export async function regenerateQuestion(
  questionId: number,
  difficulty: number,
): Promise<CreatedQuestion>;
```

既存 private `request<T>()` を `createdQuestionSchema` で呼ぶ（**レスポンス形状が同一なのでスキーマを再利用**。Tier 2b への影響を最小化）。`customErrorMsg: "再作成に失敗しました"`。

**`allowNotFound` は付けない** — `deleteQuestion` と違い 404 はフォールバック不能な失敗（表示すべき新しい問題が無い）。サーバの `Question not found` がそのまま出る。

### 8. `src/app/create/create-form.tsx` — 結果画面の状態機械

追加 state:

```ts
const [difficulty, setDifficulty] = useState(QUIZ_MIN_DIFFICULTY);
const [busy, setBusy] = useState<"regenerate" | "discard" | null>(null);
```

`loading`（初回生成用）は据え置き。`busy` は `result !== null` の分岐でのみ使うので同時に立たない。

**難易度を上げて再作成**:

```
if (busy || difficulty >= QUIZ_MAX_DIFFICULTY) return;   // 二重発火ガード
const next = difficulty + 1;
setBusy("regenerate"); setError(null);
try {
  const data = await regenerateQuestion(result.id, next);
  setResult(data);          // id が新しい問題に差し替わる
  setDifficulty(next);      // ★ 成功後にのみ繰り上げる
} catch (e) {
  setError(errorMessage(e, "再作成に失敗しました"));  // difficulty は据え置き＝再試行で同じ Lv を狙える
} finally { setBusy(null); }
```

**破棄**:

```
if (busy) return;
setBusy("discard"); setError(null);
try {
  await deleteQuestion(result.id);
  setResult(null);
  setDifficulty(QUIZ_MIN_DIFFICULTY);   // text は保持
} catch (e) { setError(errorMessage(e, "破棄に失敗しました")); }
finally { setBusy(null); }
```

その他の変更点:

- **`ErrorMessage` を結果分岐にも置く**。現状 `error` は `!result` 分岐にしか描画されていないため、追加しないと再作成/破棄の失敗が**画面に一切出ない**。
- 「続けてもう1問作る」でも `setDifficulty(QUIZ_MIN_DIFFICULTY)` と `setError(null)` を行う（分岐をまたぐ際の state 残留を防ぐ）。
- 初回生成の `handleCreate` も `setDifficulty(QUIZ_MIN_DIFFICULTY)` を明示（破棄後に再生成した時の取りこぼし防止）。

**難易度インジケータ**（これが無いとボタンの効果が観測できない）:

- `difficulty > 1` のとき `QuestionCard` の上に `難易度 Lv.{difficulty}` バッジ。`bg-surface-2 text-muted rounded-card` 系の ad-hoc スタイル（`StatCard` / `EmptyState` と同じ流儀）。
- `role="status" aria-live="polite"` の `sr-only` 領域に「難易度 Lv.N で再作成しました」を流す（`question-list.tsx` のライブリージョンと同じ手法）。
- `difficulty >= QUIZ_MAX_DIFFICULTY` でボタンを `disabled` にし、`text-sm text-muted` で「これ以上は難易度を上げられません」。**`aria-label` は使わない** — アクセシブル名を上書きすると `getByRole("button", { name: "難易度を上げて再作成" })` と Playwright の日本語ロケータが壊れる。

**ボタン配置**（5 個になるので階層を整理する）:

```
[難易度を上げて再作成]  outline   ← この問題への操作
[破棄]                  danger
──────────── <hr className="border-border/60" /> ────────────
[続けてもう1問作る]     ghost     ← 既存。outline から降格
[問題を解きに行く]      primary   ← 既存のまま
[ホームへ]              ghost     ← 既存のまま
```

- 区切り線で「この問題への操作」と「次の行動」を分離する。
- 「続けてもう1問作る」を `outline` → `ghost` に降格するのは、新設の再作成ボタンと outline が重複して強調が二段になるため。**これが既存 UI への唯一の変更**。
- 既存 3 ボタンのラベル・並び順は変えない（E2E とスナップショット的な期待を壊さない）。
- 全ボタンは `Button` の `min-h-12` を継承。再作成中/破棄中は両方 `disabled`（`busy !== null`）にして、片方だけ押せる状態を作らない。

---

## テスト

| ファイル                                         | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/llm/prompts.test.ts`（追記）              | **`buildQuizPrompt(text, 1)` が現行 `QUIZ_GENERATION_PROMPT` 相当と一致**（Lv1 不変の担保）。Lv2〜5 でディレクティブが入る。範囲外（0 / 6 / NaN）で Lv1 にフォールバック。「テキストのみから一意に決定できる」制約文が全 Lv に含まれる。**`{{DIFFICULTY}}` を含むソーステキストを渡してもディレクティブが注入されない**（置換順序の回帰テスト）                                                                                                                                |
| `tests/llm/quiz.test.ts`（追記）                 | `difficulty` 省略時に現行と同じプロンプト・`maxTokens=512`。Lv3 でディレクティブが含まれ `maxTokens=1024`。`callGemini` の第 2 引数を assert                                                                                                                                                                                                                                                                                                                                   |
| `tests/db/question-repository.test.ts`（追記）   | `getQuestionSource`: 取得できる / 未存在は `null`。`replaceKnowledgeWithQuestion`: 新 id が返る・**旧問題と旧 knowledge と旧 answerLogs が消える**・**別の問題とその関連行が無傷**（過剰削除の回帰）・未存在 id で `null`・`createKnowledgeWithQuestion` が非回帰                                                                                                                                                                                                              |
| `tests/api/questions-regenerate.test.ts`（新規） | `tests/api/questions-id.test.ts` と同形式（`ctx = (id) => ({ params: Promise.resolve({ id }) })`）。200 / id 不正で 400 / `difficulty` が 1・6・非整数・欠落で 400（かつ `generateQuestion` 未呼出）/ source 無しで 404（**`generateQuestion` を呼ばないこと**）/ 生成 null で 500（**`replaceKnowledgeWithQuestion` を呼ばないこと**）/ 置換 null で 404 / reject で 500（`console.error` を spy して restore）                                                               |
| `tests/api/client.test.ts`（追記）               | URL `/api/questions/1/regenerate`、`method: "POST"`、body に `difficulty`。200 で解決。**404 が reject すること**（`deleteQuestion` と挙動が違う点の明示）。500 でサーバのメッセージ。スキーマ不一致でエラー                                                                                                                                                                                                                                                                   |
| `tests/create/create-form.test.tsx`（新規）      | `next/navigation` と `@/lib/api/client` を `vi.mock`。生成前は新ボタンが出ない / 再作成成功で問題文が差し替わり **Lv バッジが出る** / 連打で Lv が積み上がる / **失敗時は Lv が上がらず `ErrorMessage` が出て古い問題が残る** / Lv5 でボタンが `disabled` + 注記 / 破棄成功で textarea に戻り**テキストが残る** / 破棄失敗でエラー表示・結果は残る / pending 中に両ボタンが `aria-busy` + `disabled`（deferred promise で観測）/ 「続けてもう1問作る」で Lv とエラーがリセット |
| `tests/create/page.test.tsx`（新規）             | `render(await CreatePage())` で薄いシェルの描画。`tests/answer/page.test.tsx` の前例あり                                                                                                                                                                                                                                                                                                                                                                                       |
| `tests/e2e/create.spec.ts`（追記）               | 再作成でカードが差し替わり Lv バッジが出る / 破棄でフォームに戻る。**実 DB を壊さないため、破壊的クリック前に必ず `page.route` で fulfill する**                                                                                                                                                                                                                                                                                                                               |

### E2E のルート登録順（ハマりどころ）

Playwright はハンドラを**登録の逆順**で照合する。glob の `*` は `/` を跨がないので `**/api/questions/*` は `/api/questions/1/regenerate`（3 セグメント）にマッチしないが、事故を避けるため **汎用 → 具体の順に登録**する:

```ts
await page.route("**/api/questions", ...);              // POST 作成
await page.route("**/api/questions/*", ...);            // DELETE 破棄
await page.route("**/api/questions/*/regenerate", ...); // POST 再作成（最後＝最優先）
```

### カバレッジ Tier — `scripts/check-coverage-tiers.mjs` に Tier 7 を追加

```js
{ name: "Tier 7: Question creation UI", target: 85, metric: "statements",
  patterns: [/\/app\/create\/.+\.(ts|tsx)$/] },
```

- **`src/app/create/**` は現在どの Tier にもマッチせず、ユニットテストも存在しない**。そこに状態機械（再作成 / 破棄 / Lv 繰り上げ / エラー復帰）を載せるのだから、無ゲートのままにはできない。
- Tier 6（`/questions`, 85%）と同じ target・同じ理由づけで揃える。
- 注意: **0 ファイルにマッチする Tier はハードエラー**。`src/app/create/` を消すときは Tier 7 も一緒に消す。
- `[id]/regenerate/route.ts` は Tier 2（80%）に、`regenerateQuestion` は Tier 2b（85%）に、`prompts.ts` / `quiz.ts` は Tier 2 に、リポジトリは Tier 3（75%）に加算されるので、それぞれ非回帰を確認する。

---

## 仕様書更新 — `openspec/specs/study/spec.md`

`scripts/check-spec-refs.sh` は push でブロックするため、**実ファイル作成後（同一コミット内）に書く**。

- **Requirements**: `### R8: Difficulty Escalation & Discard` を追加（WHEN/THEN 形式）。Lv1〜5 の範囲、生成先・削除後の順序保証、失敗時に旧問題が残ること、破棄でソーステキストを保持すること、**`/questions` と違い確認ダイアログを置かない理由**を明記。
- **API Specification**: `### 5. POST /api/questions/[id]/regenerate` を追加。Path Param / Request `{ difficulty: 2..5 }` / 200・400・404・500 のボディ / **201 でなく 200 である理由** / `maxDuration = 300`。
- **Components**: `### 2. /create` を拡張（結果画面の状態機械 `idle → regenerate | discard`、Lv バッジ、ライブリージョン、ボタン階層、「続けてもう1問作る」の `ghost` 降格）。
- **LLM Integration**: `Max Tokens 512` を「512（difficulty 1）/ 1024（difficulty ≥ 2）」に更新。難易度ディレクティブ表と「正解は入力テキストのみから一意に決定可能」制約を追記。Lv1 プロンプトが従来と一致することを明記。
- **Database**: Repositories の関数一覧に `getQuestionSource` / `replaceKnowledgeWithQuestion` を追加。**再作成で旧 `answerLogs` が失われる**ことを cascade ポリシーに追記。
- **Testing**: unit のカウントを **`pnpm test` の実測値**に更新（推測しない。現行 183）。E2E も実測値に更新（現行 38 + 追加 test 数 × 2 project）。モジュール一覧に `tests/create/*`, `tests/api/questions-regenerate.test.ts` を追加。Tier 7 を tier 一覧に追加（`/create` 削除時は Tier も削除、と注記）。
- **Non-Functional**: 「破壊的操作のうち、生成直後で履歴ゼロかつ入力が復元可能なものは確認をスキップする」を 1 行追加（R7 との非対称の根拠）。

### codemap 更新

- `src/app/codemap.md`: `api/questions/[id]/regenerate/route.ts`、`create/` の責務更新
- `src/lib/codemap.md`: `llm/prompts.ts` の `buildQuizPrompt` / `DIFFICULTY_DIRECTIVES`、`api/client.ts` の `regenerateQuestion`
- `src/lib/db/codemap.md`: `getQuestionSource` / `replaceKnowledgeWithQuestion`
- ルート `codemap.md`: File Structure の `api/questions/` ツリー

---

## 実装順序

1. `src/lib/constants.ts`（難易度定数 + `LLM_QUIZ_MAX_TOKENS_HARD`）
2. `src/lib/llm/prompts.ts`（`buildQuizPrompt` / `DIFFICULTY_DIRECTIVES`）+ テスト ← **Lv1 一致を最初に固定する**
3. `src/lib/llm/quiz.ts`（`difficulty` 引数）+ テスト
4. `src/lib/db/repository/question-repository.ts`（`getQuestionSource` / `replaceKnowledgeWithQuestion` / `insertKnowledgeAndQuestion` 抽出）+ テスト
5. `src/lib/api/schemas.ts`（`regenerateQuestionSchema`）
6. `src/app/api/questions/[id]/regenerate/route.ts` + テスト
7. `src/lib/api/client.ts`（`regenerateQuestion`）+ テスト
8. `src/app/create/create-form.tsx`（状態機械 + Lv バッジ + ボタン階層 + 結果分岐の `ErrorMessage`）+ テスト
9. `tests/create/page.test.tsx`
10. `scripts/check-coverage-tiers.mjs` に Tier 7 → カバレッジを回して 85% 到達まで反復
11. `tests/e2e/create.spec.ts` 追記
12. `spec.md`（**実測テスト数を使う**）
13. codemap 一式

---

## 検証

```bash
pnpm format:check && pnpm lint:fast
pnpm type-check:fast && pnpm type-check   # regenerate route の context narrow を検証
pnpm test                                  # ← 実測カウントを spec.md に反映
pnpm exec vitest run --coverage && node scripts/check-coverage-tiers.mjs  # 7/7 PASS、Tier 7 が N/A でないこと
bash scripts/check-spec-refs.sh
pnpm test:e2e
pnpm build                                 # [id]/regenerate ルートの生成型を検証
```

### 手動確認（`pnpm dev` + 実 Turso DB + 実 Gemini）

1. `/create` でナレッジを入力 → 生成。Lv バッジは**出ない**（Lv1）。
2. 「難易度を上げて再作成」→ スピナー → 問題が差し替わり `難易度 Lv.2` が出る。体感で難しくなっている。
3. `pnpm db:studio` で **旧 `questions` / 旧 `knowledge` が消えている**こと、新しい行が 1 組だけあることを確認（**二重に残っていたら設計が破綻している**）。
4. さらに 3 回押して Lv5 → ボタンが `disabled` になり「これ以上は難易度を上げられません」が出る。
5. Lv5 の問題の解説が途中で切れていないこと（`LLM_QUIZ_MAX_TOKENS_HARD` の効果確認）。
6. 「破棄」→ フォームに戻り、**textarea に元のテキストが残っている**。
7. `db:studio` で問題・knowledge が消えていること。`/` の「問題数」が元に戻っていること。
8. 破棄後にそのまま「この内容から1問作る」→ **Lv1 として生成される**（Lv が引き継がれていない）。
9. 失敗系: `GOOGLE_API_KEY` を一時的に壊して再作成 → 赤いエラーが出て、**古い問題がカードに残り、Lv が上がっていない**。キーを戻して再試行すると同じ Lv を狙える。
10. 失敗系: DevTools で DELETE を失敗させ、「破棄に失敗しました」が出て結果画面に留まること。
11. 再作成の pending 中に「破棄」が押せない（両方 disabled）。
12. Pixel 5 幅 + dark mode: 5 ボタン + 区切り線が破綻せず、`danger` の「破棄」が可読、各ボタン 48px 以上。
13. `prefers-reduced-motion: reduce` でカード差し替えのアニメーションが走らない。
14. スクリーンリーダー: 再作成後に「難易度 Lv.2 で再作成しました」が読み上げられる。

---

## 注意点（ハマりどころ）

1. **LLM をトランザクション内で呼ばない**。45s × 3 リトライの間 write tx を開くと Turso が詰まる。
2. **生成成功を確認してから DB を触る**。先に消すと生成失敗で問題を丸ごと失う。
3. **クライアント側で「POST → DELETE」にしない**。DELETE 落ちで孤児問題が抽選プールに残る。専用ルート + 1 トランザクション。
4. **`difficulty` は成功後にのみ繰り上げる**。失敗時に上げると、押すたびに実際には作られていない Lv だけが進む。
5. **`{{DIFFICULTY}}` を `{{SOURCE_TEXT}}` より先に置換する**。逆にするとユーザー入力からプロンプトインジェクションできる。
6. **「テキストのみから一意に決定できる」制約を全 Lv 共通で入れる**。無いと高難易度がテキスト外知識を要求する幻覚問題に退化する。
7. **512 トークンのままにしない**。難問は打ち切られて不正 JSON になり、parse リトライを食い潰して 500 になる。
8. Next 16 の `params` は Promise。`await` せずに `safeParse` すると全リクエストが 400。
9. `regenerate` に `maxDuration = 300` を付け忘れると Vercel のデフォルトで切れる。
10. `regenerateQuestion` に `allowNotFound` を付けない（`deleteQuestion` と対称にしたくなるが、404 は表示すべき問題が無い状態＝失敗）。
11. **結果分岐に `ErrorMessage` を追加する**。現状 `error` は入力分岐にしか描画されておらず、忘れると失敗が完全に無言になる。
12. `cn()` はマージしない → 破棄ボタンを `ghost` + `text-error` で作らない。`danger` variant を使う。
13. **Tier 7 追加は不可逆的コミット**。0 マッチ Tier はハードエラーなので `/create` を消すときは Tier も消す。
14. `check-spec-refs.sh` は blocking → ファイル作成前に spec.md にパスを書かない。
15. spec.md のテスト件数は**推測せず `pnpm test` / `pnpm test:e2e` の実測値**を書く。
16. E2E で実 API を叩かない。再作成/破棄のクリック前に必ず `page.route`。登録は汎用 → 具体の順。

---

## 非目標（今回やらないこと）

- `questions` テーブルへの `difficulty` 列追加（drizzle マイグレーションが要る。Lv はクライアント state に留める）。
- `/questions` 一覧からの再作成（本計画は `/create` の生成直後フローのみ）。
- 難易度を**下げる**操作。
- 再作成の Undo（旧問題は完全に削除される）。

---

# デプロイ失敗の検証と改善プラン（2026-08-19 追記）

本計画を実装・コミット（`10dea54 feat: 難易度を上げて再作成 / 破棄アクションを追加`）した後、Vercel の production デプロイが失敗した。その原因調査と再発防止の記録。

## 1. 観測された事実

| 項目           | 内容                                                                       |
| -------------- | -------------------------------------------------------------------------- |
| デプロイ       | `study-6kmlll1lu`（Production, commit `10dea54`）                          |
| 状態           | **● Error / 14s**                                                          |
| GitHub Actions | 同 commit で **failure**。落ちたステップは **`Type Check`**（以降は skip） |

Vercel ビルドログの該当箇所:

```
✓ Compiled successfully in 3.5s
Running TypeScript ...
src/lib/db/repository/question-repository.ts(190,7): error TS2554: Expected 1 arguments, but got 2.
Failed to type check.
Error: Command "pnpm build" exited with 1
```

CI と Vercel が同一のエラーで落ちている。つまり **Vercel 固有の問題ではなく、コミット済みツリーが型チェックを通らない**。

## 2. 原因 — 本計画の実装ではなく、部分コミットによる巻き込み事故

| ツリー         | `weighting.ts` の `computeWeight`                  | `question-repository.ts:190` の呼び出し |
| -------------- | -------------------------------------------------- | --------------------------------------- |
| **HEAD**       | `computeWeight(stats)` — **1 引数**                | `computeWeight(..., now)` — **2 引数**  |
| **作業ツリー** | `computeWeight(stats, now)` — 2 引数（未コミット） | 同上                                    |

`src/lib/db/repository/weighting.ts` の 2 引数化は **`15-QUESTION_PRIORITY_WEIGHTING_PLAN.md`（プラン15）の実装**であり、`tests/db/weighting.test.ts` と合わせて **未コミットのまま作業ツリーに置かれていた**（`git status` で `M` 2 ファイル、計 +272 / −22 行）。

本計画のコミット `10dea54` は `question-repository.ts` をステージした。このファイルには

- 本計画の追加（`getQuestionSource` / `replaceKnowledgeWithQuestion`）
- **プラン15 の `now` 引数追加**

が同居しており、**呼び出し側だけがコミットされ、シグネチャ側が取り残された**。

**結論: 本計画の設計・実装に欠陥は無い。** 別計画の未コミット変更を同一ファイル経由で巻き込んだ事故である。

## 3. なぜ全ゲートをすり抜けたか（本質）

> **フックは「作業ツリー」を検証し、CI / Vercel は「コミット済みツリー」を検証する。**

| 検証                                                          | 対象ツリー            | 結果                   |
| ------------------------------------------------------------- | --------------------- | ---------------------- |
| pre-commit `tsgo --noEmit`                                    | 作業ツリー            | ✅ PASS                |
| pre-push Stage 0〜5（プラン17で追加した `pnpm build` を含む） | 作業ツリー            | ✅ PASS                |
| ローカル `NEXT_BUILD=1 pnpm build`（本調査で再実行）          | 作業ツリー            | ✅ **PASS してしまう** |
| GitHub Actions `Type Check`                                   | `git clone` した HEAD | ❌ `TS2554`            |
| Vercel `pnpm build`                                           | `git clone` した HEAD | ❌ `TS2554`            |

作業ツリーには 2 引数版 `weighting.ts` が存在するので、ローカルのゲートは**全て正しく PASS する**。壊れているのはコミット済みツリーだけであり、ローカルからは原理的に見えない。

**検証済み**: `git worktree add --detach <tmp> HEAD` で HEAD を展開し `tsgo --noEmit` を実行すると、**Vercel と一字一句同じ `TS2554`** が再現した（作業ツリーは一切触っていない）。

### プラン17 との関係

`17-CI_PARITY_PREPUSH_HOOK_PLAN.md` は「pre-push を CI の**チェック項目**の上位集合にする」ことを達成した（実際 `b141112` 以降 CI は success に戻っている）。しかし **「同じチェックを、同じ*ツリー*に対して走らせる」ことは扱っていなかった**。ここが残った穴である。

さらに本障害は `31729b2`（`package.json` だけコミットし `pnpm-lock.yaml` が漏れた）と**完全に同型**である。プラン17 は lockfile ペアという特殊形を個別に潰したが、一般形は **「相互依存するファイル群の部分コミット」** であり、今回 `weighting.ts` ↔ `question-repository.ts` で再発した。

---

## 4. 改善プラン

### 4-1. 即時復旧（最優先・これ単独でデプロイは直る）

`src/lib/db/repository/weighting.ts` と `tests/db/weighting.test.ts` をコミットする。プラン15 の成果物なので、プラン15 側の「実装完了・検証記録」も同時に書く。

- **`question-repository.ts` から `now` 引数を落とすリバートは採らない。** 作業ツリーのプラン15 実装（+232 行のテストを含む）を捨てることになり、テストとも矛盾する。壊れているのは「コミットが足りない」側であって、コードではない。
- コミット前に **4-2 の手順で HEAD ではなく「これからコミットする内容」が型チェックを通ること**を確認する。

### 4-2. `scripts/check-head-typecheck.sh`（新規）— pre-push Stage 0 に追加

push される ref を **リポジトリ外の detached worktree** に展開し、コミット済みツリーに対して型チェックする。**実測 1.35 秒**。これを入れていれば、Vercel と同一のエラーで 1.35 秒後に push が止まっていた。

```bash
ROOT=$(git rev-parse --show-toplevel)
WT=$(mktemp -d)
trap 'git worktree remove --force "$WT" 2>/dev/null; rm -rf "$WT"' EXIT

git worktree add --detach "$WT" "$PUSH_REF" >/dev/null
ln -s "$ROOT/node_modules" "$WT/node_modules"
"$ROOT/node_modules/.bin/tsgo" --noEmit -p "$WT/tsconfig.json"
```

実装上の注意（**すべて本調査で実際に踏んで検証済み**）:

1. **worktree をリポジトリ内に作らない。** `git status` を汚し、誤ってコミットされうる。`mktemp -d` でリポジトリ外に置く。
2. **`pnpm exec tsgo` を使わない。** worktree 内で pnpm を起動すると `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` を出して **node_modules を消しにかかる**（本調査で実際に発生）。`node_modules/.bin/tsgo` を**直接**呼ぶこと。
3. **`node_modules` は symlink で共有する。** worktree 側で `pnpm install` すると Stage 0 の「6 秒」設計が崩壊する。symlink + `tsgo -p` で型解決は正常に動くことを確認済み。
4. **`trap ... EXIT` で必ず後始末する。** フック中断で worktree が残ると、次回の `git worktree add` が同名で失敗して push できなくなる。
5. 検証対象 ref は pre-push の **stdin**（`<local ref> <local sha> <remote ref> <remote sha>`）から取るのが正確。簡易版は `HEAD` で足りる。
6. エラーメッセージには **「作業ツリーは通るがコミット済みツリーが壊れている ＝ コミット漏れがある」**と明記する。素の `TS2554` だけ出しても、開発者はローカルで再現できず混乱する。今回の障害の本質はここなので、文言が再発防止の主役になる。

### 4-3. `.husky/pre-commit` — 作業ツリー汚れの警告（non-blocking）

`src/` 配下に**ステージされていない変更**を残したまま commit しようとした場合に warn する。`scripts/check-spec-update.sh` と同じ枠付き警告の体裁を踏襲する。

**block しない理由**: WIP を抱えたまま別件を分割コミットするのは正当な運用であり、block すると `AGENTS.md` が禁じる `--no-verify` に開発者を追い込む。実効的なゲートは 4-2 の pre-push 側に置く。

### 4-4. プラン17 への波及（`17-CI_PARITY_PREPUSH_HOOK_PLAN.md` を更新）

- 不変条件を **「pre-push は CI と同じ*チェック*を、同じ*ツリー*に対して走らせる」** に強化する。
- `spec.md` の CI / フック対応表に **「検証対象ツリー」列**を追加する。この列があれば、今回の穴は表を見た時点で気づける。
- 同じ理屈で `scripts/check-lockfile-sync.sh` も HEAD に対して走らせるべき（現状は作業ツリーの `package.json` を見ているため、`package.json` が未コミットのまま dirty だと `31729b2` を再び取り逃す）。ただし **worktree 内で `pnpm` を起動する必要があるため注意点 2 の node_modules 破壊ハザードに当たる**。`git show HEAD:package.json` / `git show HEAD:pnpm-lock.yaml` を node_modules を持たない一時ディレクトリに書き出して `pnpm install --frozen-lockfile --lockfile-only` を回す形が安全と思われるが、**未検証**。プラン17 側で実測してから採用すること。

---

## 5. 改善プランの非目標

- **全ゲート（unit / E2E / coverage / build）を worktree で回すこと。** 型チェックは 1.35 秒だが、build は数十秒、E2E は分単位で、しかも `.next` や Playwright の都合で node_modules の symlink 共有だけでは済まない。**今回の障害も `31729b2` 型の障害も型チェック（と lockfile 検証）で捕捉できる**ので、費用対効果からここに絞る。
- **`git stash` 方式でのコミット済みツリー検証。** フックが中断された場合にユーザーの変更が stash に取り残される。worktree 方式は作業ツリーを一切触らないため、この危険が無い。
- **CI ワークフローの変更。** プラン17 と同じく、CI がゲートの正本であり寄せるのはフック側。

## 6. 検証手順（改善実装後）

```bash
# 1. 4-1 のコミット前に、コミット予定の内容が型チェックを通ることを確認
bash scripts/check-head-typecheck.sh      # ← まず現 HEAD で TS2554 が出ること（再現確認）

# 2. weighting.ts / weighting.test.ts をコミット後、同じスクリプトが PASS すること
bash scripts/check-head-typecheck.sh

# 3. 実行後に worktree が残っていないこと（trap の確認）
git worktree list                          # ← 本体 1 行のみ
git status --porcelain | grep -c headcheck # ← 0

# 4. 通常の全ゲート
pnpm format:check && pnpm lint:fast && pnpm type-check:fast && pnpm type-check
pnpm test && pnpm exec vitest run --coverage && node scripts/check-coverage-tiers.mjs
bash scripts/check-spec-refs.sh && pnpm security-check && pnpm test:e2e
NEXT_BUILD=1 pnpm build

# 5. push 後、CI と Vercel の両方が Ready になることを確認
gh run list --limit 1
vercel ls | head -3
```

### 再現テスト（このプランの合否そのもの）

`weighting.ts` の変更を一時的に unstage したまま `question-repository.ts` だけをコミットして push を試み、**Stage 0 が 2 秒以内に `TS2554` で止まる**こと。止まらなければ 4-2 は失敗している。
