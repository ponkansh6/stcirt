import { gradeFreeResponse, gradeFreeResponseParts } from "../src/lib/jev/adapter.ts";
import { q5KeywordHits, scoreQ5 } from "../src/lib/jev/scoring.ts";
import { JEV_QUESTION_VERSION, JEV_RUBRIC_VERSION } from "../src/lib/jev/versions.ts";

function parseAnswers(args: string[]): { answers: { a: string; b: string }; forceJev: boolean } {
  const answers: Partial<{ a: string; b: string }> = {};
  let forceJev = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--force-jev") {
      if (forceJev) throw new Error("Duplicate --force-jev.");
      forceJev = true;
      continue;
    }
    if (flag !== "--a" && flag !== "--b") {
      throw new Error("Unknown argument. Provide both --a and --b; --force-jev is optional.");
    }
    const part = flag.slice(2) as "a" | "b";
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}.`);
    }
    if (answers[part] !== undefined) throw new Error(`Duplicate ${flag}.`);
    answers[part] = value;
    index += 1;
  }

  if (!answers.a || !answers.b) {
    throw new Error(
      'Usage: pnpm jev:q7:smoke -- --a "回答A" --b "回答B" [--force-jev] (reads TYPESAFE_API_KEY from .env.local)',
    );
  }
  return { answers: { a: answers.a, b: answers.b }, forceJev };
}

async function main() {
  const { answers, forceJev } = parseAnswers(process.argv.slice(2));
  const keywordHits = q5KeywordHits(answers);
  const result = forceJev
    ? await Promise.all([
        gradeFreeResponse(answers.a, JEV_QUESTION_VERSION, JEV_RUBRIC_VERSION, "a"),
        gradeFreeResponse(answers.b, JEV_QUESTION_VERSION, JEV_RUBRIC_VERSION, "b"),
      ]).then(([a, b]) => ({ a, b }))
    : await gradeFreeResponseParts(answers, JEV_QUESTION_VERSION, JEV_RUBRIC_VERSION);
  const aScore = result.a?.score ?? null;
  const bScore = result.b?.score ?? null;

  console.log(
    JSON.stringify(
      {
        questionVersion: JEV_QUESTION_VERSION,
        rubricVersion: JEV_RUBRIC_VERSION,
        forceJev,
        model:
          "model" in result
            ? result.model
            : [...new Set([result.a.model, result.b.model])].join(","),
        keywordMatches: keywordHits,
        skippedBecauseOfKeyword: forceJev ? { a: false, b: false } : keywordHits,
        parts: {
          a: result.a
            ? { source: forceJev ? "jev-forced" : "jev", ...result.a }
            : { source: "keyword-override" },
          b: result.b
            ? { source: forceJev ? "jev-forced" : "jev", ...result.b }
            : { source: "keyword-override" },
        },
        productionScore: scoreQ5(answers, { a: aScore, b: bScore }),
        note: forceJev
          ? "JEV was called for both parts. Production scoring still applies keyword overrides."
          : "Keyword-matched parts skip JEV and receive the production keyword override. Use --force-jev to call JEV for both parts.",
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown JEV smoke test error";
  console.error(`JEV smoke test failed: ${message}`);
  process.exitCode = 1;
});
