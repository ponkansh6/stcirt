export async function main(args = process.argv.slice(2)) {
  if (
    args.some((argument) => argument !== "--apply") ||
    args.filter((arg) => arg === "--apply").length > 1
  ) {
    console.error(
      "Usage: node --env-file=.env.local --import tsx scripts/repair-q5-scoring.ts [--apply]",
    );
    process.exitCode = 2;
    return;
  }

  try {
    const { repairQ5Scoring } = await import("@/lib/db/repository/q5-scoring-repair");
    const result = await repairQ5Scoring({ apply: args.includes("--apply") });
    console.log(
      `Q5 scoring repair ${result.applied ? "applied" : "dry-run"}: ` +
        `${result.assessmentCount} assessments, ${result.snapshotCount} snapshots, ` +
        `${result.entryCount} entries.`,
    );
  } catch {
    console.error("Q5 scoring repair failed; no changes were committed.");
    process.exitCode = 1;
  }
}

void main();
