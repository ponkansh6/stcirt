# study プロジェクト新規作成

## Context

`/home/shunki/working/` 配下に新規プロジェクト `study` を作る。ユーザーが文章で「知識」を入力すると、LLMがそれを4択クイズ10問1セットに変換して保存し、出題順をランダムにして解答できるアプリ。

- 開発ツール/設定一式は `nextjstest` と完全に揃える(ユーザー確認済み: 「完全一致」)。
- LLM呼び出し・DB保存の実装パターンは `news-watch` を参照する(ユーザー指定)。
- GitHubリモートは `gh` CLIで新規作成しpushまで実施(ユーザー確認済み)。
- DB(Turso)は既存のものを流用(ユーザー確認済み。接続情報は実装時に `.env.local` へユーザーが設定)。
- v1ではクイズの回答結果(スコア・正誤)はDB保存しない。ブラウザ内で採点のみ(ユーザー確認済み)。

## 参照した既存設定

### nextjstest(ツール設定の複製元)

- `package.json`: pnpm 11.9.0 / node >=24, scripts(`dev`/`build`/`test:all`/`lint:fast`/`type-check:fast`/`security-check`等), deps(`next@^16.2.9`, `react@^19.2.7`), devDeps(oxlint/oxfmt/eslint/prettier/husky/lint-staged/playwright/vitest/depcheck/secretlint/@typescript/native-preview/bun等)
- `next.config.ts`: Turbopack root設定 + bundle-analyzer + `reactCompiler: true` + prod `removeConsole`
- `tsconfig.json`: strict, ES2022, `moduleResolution: bundler`, path alias `@/*``@server/*`
- `eslint.config.mjs`: flat config, `eslint-config-next/core-web-vitals` + `/typescript`
- `.npmrc`(`engine-strict=true` 等)、`.node-version`(24)、`vercel.ts`(`{buildCommand:"pnpm build", framework:"nextjs"}`)
- `.husky/pre-commit`(lint:fast→oxfmt→tsgo→lint-staged)、`.husky/pre-push`(spec鮮度チェック→test:all→test:e2e)
- `.github/workflows/main.yml`(pnpm+node24 setup → type-check → lint:fast → test:all → build)
- `AGENTS.md`/`CLAUDE.md`、`openspec/config.yaml`+`openspec/specs/<project>/spec.md`、各フォルダの `codemap.md` 規約
- スタイリング: プレーンCSS + CSS Modules(Tailwind/UIライブラリなし)→ study でも踏襲

### news-watch(LLM・DB実装パターンの参照元)

- LLM: `src/lib/llm/client.ts` の `callGemini()` — `@google/generative-ai` で `gemini-3.1-flash-lite`、`responseMimeType:"application/json"`、リトライ+指数バックオフ。`src/lib/llm/schemas.ts`(Zodスキーマ)+`src/lib/llm/parser.ts`(`parseWithRetry`)でJSON検証。プロンプトは `src/lib/llm/prompts.ts` にテンプレ文字列。env: `GOOGLE_API_KEY`
- DB: Drizzle ORM + `@libsql/client`(Turso)。`src/lib/db/schema.ts`(テーブル定義)、`src/lib/db/index.ts`(`drizzle({client, schema})`)、`src/lib/db/repository/*.ts`(upsert/save関数)、`drizzle.config.ts`(dialect: turso)。env: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`

## ディレクトリ構成(study)

```
study/
  src/
    app/
      page.tsx                 # トップ: 知識入力フォーム + 過去のクイズセット一覧
      layout.tsx / globals.css / page.module.css
      quiz/[id]/page.tsx        # クイズ回答画面(4択×10問、順序シャッフル)
      quiz/[id]/QuizRunner.tsx  # "use client" 採点ロジック(結果は保存しない)
      api/
        quiz-sets/route.ts      # POST: 生成+保存 / GET: 一覧
        quiz-sets/[id]/route.ts # GET: 1セット取得(質問+選択肢)
    lib/
      llm/
        client.ts     # callGemini() — news-watchから移植
        schemas.ts     # QuizQuestionSchema(question/choices[4]/correctIndex/explanation), QuizGenerationSchema(10件配列)
        parser.ts      # parseWithRetry — news-watchから移植
        prompts.ts     # QUIZ_GENERATION_PROMPT
        quiz.ts        # generateQuizQuestions(sourceText): Promise<QuizQuestion[]>
      db/
        index.ts       # drizzle + libsql client
        schema.ts      # quizSets, questions テーブル
        repository/
          quiz-repository.ts  # createQuizSet, getQuizSet, listQuizSets
      shuffle.ts        # Fisher-Yatesシャッフル(質問順・選択肢順の両方に使用)
    types/
      quiz.ts
  drizzle.config.ts
  next.config.ts / tsconfig.json / eslint.config.mjs / vercel.ts / .npmrc / .node-version  (nextjstestから移植・調整)
  .env.local.example  (news-watchパターン: GOOGLE_API_KEY, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN)
  .github/workflows/main.yml (nextjstestから移植)
  .husky/pre-commit, pre-push (nextjstestから移植、spec pathをstudy用に変更)
  AGENTS.md / CLAUDE.md (nextjstestから移植、openspec pathをopenspec/specs/study/spec.mdに変更)
  openspec/config.yaml (studyの技術スタック/ドメイン知識に書き換え) / openspec/specs/study/spec.md
  codemap.md (ルート含む主要フォルダに配置、nextjstest規約踏襲)
  package.json (下記参照)
```

## DBスキーマ(Drizzle / SQLite via Turso)

```ts
export const quizSets = sqliteTable("quiz_sets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(), // sourceTextの冒頭から自動生成
  sourceText: text("source_text").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const questions = sqliteTable(
  "questions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    quizSetId: integer("quiz_set_id")
      .notNull()
      .references(() => quizSets.id, { onDelete: "cascade" }),
    orderIndex: integer("order_index").notNull(), // 生成順(保存用、表示時は shuffle.ts でシャッフル)
    question: text("question").notNull(),
    choices: text("choices", { mode: "json" }).notNull().$type<string[]>(), // 長さ4
    correctIndex: integer("correct_index").notNull(), // 0-3
    explanation: text("explanation"),
  },
  (t) => ({
    quizSetIdx: index("questions_quiz_set_idx").on(t.quizSetId),
  }),
);
```

- 1セット=10問固定。`createQuizSet` はDB書き込み前にLLM出力が「ちょうど10問・各4択」であることをZodで検証し、不足/不正なら再生成リトライ(news-watchの `LLM_MAX_PARSE_RETRIES` パターンを踏襲)。

## LLM プロンプト設計

`prompts.ts` の `QUIZ_GENERATION_PROMPT`:

- 入力: ユーザーが貼り付けた知識文章(`sourceText`)
- 指示: その文章から学習内容を問う4択問題をちょうど10問作成。各問題は `question`, `choices`(4件, 順不同で正解位置を偏らせない), `correctIndex`(0-3), 簡潔な `explanation`(なぜ正解か)を持つJSON配列のみを出力(`responseMimeType: application/json` で強制)。
- news-watchの `callGemini(prompt, maxTokens, timeoutMs, retries)` をそのまま流用(モデル `gemini-3.1-flash-lite`、`temperature`は低め)。

## 画面フロー

1. `/`(トップ): テキストエリアに知識文章を貼り付け→送信→`POST /api/quiz-sets`→生成完了後 `/quiz/[id]` へ遷移。ページ下部に過去のクイズセット一覧(タイトル+作成日時、クリックで再挑戦)。
2. `/quiz/[id]`: サーバー側で10問取得→クライアントコンポーネントに渡し、`shuffle.ts` で質問順・各設問の選択肢順をシャッフルしてから表示。1問ずつ回答→最後に正答数をその場で表示(DB保存なし、リロードで消える)。

## package.json 方針

- ベース: nextjstestの scripts をそのまま踏襲(`dev`/`build`/`test:all`/`lint:fast`/`format:fast`/`type-check(:fast)`/`security-check`/`prepare`) + news-watchから `db:generate`/`db:push`/`db:studio`/`check-env` を追加。
- dependencies: `next`, `react`, `react-dom`(nextjstestと同バージョン系列)、`@vercel/config` + `@google/generative-ai`, `@libsql/client`, `drizzle-orm`, `zod`, `p-limit`(news-watchから)。
- devDependencies: nextjstestの一式(oxlint/oxfmt/eslint系/prettier/husky/lint-staged/playwright/vitest/depcheck/secretlint/@typescript-native-preview/bun等)+ `drizzle-kit`(news-watchから)。
- `recharts`/`papaparse`/`arquero`/`xlsx` はstudyでは不要のため含めない。TailwindはnextjstestにならずCSS Modulesのみ採用(news-watchのTailwindは移植しない)。

## GitHubリモート・Vercel

- `gh repo create ponkansh6/study --public --source=. --remote=origin` で新規作成(可視性は nextjstest 同様 **public** をデフォルト。非公開希望であれば実装開始前に指示)。
- ローカルで `git init` → 初期コミット → `git push -u origin main`。
- `vercel.ts` はnextjstestのものをそのまま流用(`buildCommand: "pnpm build", framework: "nextjs"`)。Vercelプロジェクトへの実際のリンク/env設定はユーザー側 or 別途確認の上で実施(Turso/Google APIキーなどの秘密情報をVercelに登録する操作は実装完了後にユーザーへ確認)。

## 環境変数(.env.local、コミットしない)

```
GOOGLE_API_KEY=...
TURSO_DATABASE_URL=...
TURSO_AUTH_TOKEN=...
```

既存Turso DBを流用するため、実装時にユーザーから接続情報を受け取って `.env.local` に設定する(チャットにトークンを貼らず、ローカルファイル編集 or 環境変数コピーで対応)。`drizzle-kit push` で `quiz_sets`/`questions` テーブルをそのDBに追加作成する。

## 実装ステップ

1. ✅ `study/` ディレクトリ作成、`pnpm create next-app` 相当の最小構成を手動で用意(nextjstestの設定ファイル群をコピー・調整)。
2. ✅ package.json 整備 → `pnpm install` (postcss 依存解決、husky pre-commit hook対応)。
3. ✅ `src/lib/db/schema.ts`, `drizzle.config.ts`, `src/lib/db/index.ts`, `repository/quiz-repository.ts` 実装。
4. ✅ `.env.local` にユーザー提供のTurso接続情報+GOOGLE_APIKEYを設定(news-watchから流用)。
5. ✅ `src/lib/llm/*`(client/schemas/parser/prompts/quiz.ts)実装 — news-watchパターンから移植・調整。
6. ✅ API routes(`/api/quiz-sets`, `/api/quiz-sets/[id]`)実装。
7. ✅ UI(`src/app/page.tsx`, `src/app/quiz/[id]/*`, `src/lib/shuffle.ts`)実装 — CSS Modules + React 19。
8. ✅ ツール設定移植: eslint/oxlint/oxfmt/prettier/husky/lint-staged/AGENTS.md/openspec/codemap.md。
9. ⏳ `pnpm lint:fast` / `pnpm type-check` / `pnpm test:all` / `pnpm build` — husky build scripts承認後実行。
10. ✅ `gh repo create ponkansh6/study --public` でリモート作成 → `git push` 完了。

## 検証方法

- `pnpm dev` でローカル起動し、ブラウザで実際に知識文章を貼り付けて生成→10問4択で表示されること、リロード/再挑戦で出題順が変わることを目視確認。
- `pnpm db:studio` で `quiz_sets`/`questions` にレコードが保存されていることを確認。
- `pnpm lint:fast && pnpm type-check:fast && pnpm test:all && pnpm build` がグリーンであることを確認。
- `pnpm exec playwright test` (E2E最小ケース: 入力→生成→回答→結果表示)を用意して実行。
