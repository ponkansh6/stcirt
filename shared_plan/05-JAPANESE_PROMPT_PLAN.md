# 問題生成プロンプトに日本語指定を追加する改善プラン

## Context

`/create` の「この内容から1問作る」機能は、`src/app/api/questions/route.ts` → `src/lib/llm/quiz.ts` → `src/lib/llm/client.ts`（Google Gemini SDK, モデル `gemini-3.1-flash-lite`）経由で、`src/lib/llm/prompts.ts` の `QUIZ_GENERATION_PROMPT` をLLMに渡して問題を生成している。

このプロンプト（`src/lib/llm/prompts.ts:1-17`）は全文英語で書かれており、**「日本語で生成すること」という言語指示が一切ない**。ユーザー入力（`{{SOURCE_TEXT}}`）が日本語であっても、モデルが英語で問題・選択肢・解説を生成してしまうことがある。出力スキーマ（`src/lib/llm/schemas.ts` の `QuizQuestionSchema`）も `z.string()` のみで言語制約はなく、プロンプト側でしか制御できない。

プロンプト定義はこの1ファイル・1箇所のみで、リトライ処理（`client.ts`, `parser.ts`）も同じプロンプト文字列を再送するだけなので、修正箇所は限定的。

**ゴール**: プロンプトに明示的な日本語生成指示を追加し、英語で生成される確率を下げる。

**スコープ外**: 出力後にzodスキーマや後処理で言語を検証・強制すること（LLM出力の言語を機械的に判定するのは別タスク）。`openspec/specs/study/spec.md` の更新（プロンプト内部の実装詳細であり、既存の要件記述に言語の明記がないため、必要なら別途ユーザーに確認）。

---

## 変更内容

### `src/lib/llm/prompts.ts`

`QUIZ_GENERATION_PROMPT` に日本語指示を2箇所追加する（LLMは指示の反復・出力直前の指示を重視しやすいため、ルール冒頭と出力直前の両方に入れる）。

- ルールリストの先頭に追加:
  `- ALL generated content (question, choices, explanation) MUST be written in Japanese (日本語), regardless of the language of the input text.`
- 「Return ONLY a valid JSON object...」の行にも日本語指定を明記する形に変更:
  `- Return ONLY a valid JSON object with this structure, with all text values in Japanese (no markdown, no code blocks, just raw JSON):`

既存のプロンプト構造・JSON例・`{{SOURCE_TEXT}}` プレースホルダーはそのまま維持する。

---

## テスト

- `tests/llm/` 配下に軽量なテストを追加し、`QUIZ_GENERATION_PROMPT` に日本語指示（例: `"Japanese"` または `"日本語"` を含む）が含まれることをアサートする（実際のLLM呼び出しはせず、プロンプト文字列の内容チェックのみ）。将来誰かがこの指示を誤って削除した場合に検知できるようにする。
- 既存の `tests/api/questions.test.ts`（`generateQuestion` をモック化）・`tests/llm/schemas.test.ts` は変更不要（プロンプト内容に依存していない）。

---

## 実装順序

1. `src/lib/llm/prompts.ts` の `QUIZ_GENERATION_PROMPT` に日本語指示を追加
2. `tests/llm/prompts.test.ts`（新規）でプロンプト内容の回帰テストを追加
3. `pnpm type-check` / `pnpm lint` / `pnpm test` で検証

AGENTS.md の制約に従い、`--no-verify` / `HUSKY=0` は使用しない。

---

## 検証

```bash
pnpm type-check
pnpm lint
pnpm test
```

手動確認（`pnpm dev` で `/create` から実際に問題を生成し、日本語で生成されることを目視確認。LLM出力は非決定的なため複数回試すことを推奨）。

---

## 進捗

- [100%] `QUIZ_GENERATION_PROMPT` に日本語生成指示（ルール先頭＋出力構造ライン）を追加し、`tests/llm/prompts.test.ts` で回帰テストを追加。`pnpm type-check` / `pnpm lint` / `pnpm test` で検証完了。
