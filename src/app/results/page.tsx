import { Suspense } from "react";
import { cookies } from "next/headers";
import Link from "next/link";
import ResultsPanel from "./results-panel";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import {
  getParticipantResult,
  type ParticipantResult,
} from "@/lib/db/repository/presentation-repository";
import { resolveAnswerScope } from "@/lib/participants/answer-scope";
import { getAssistedParticipant } from "@/lib/db/repository/assisted-participant-repository";
import { getLatestAnswerSubmission } from "@/lib/db/repository/answer-repository";
import { PARTICIPANT_COOKIE, verifyParticipantSession } from "@/lib/participants/security";

export const dynamic = "force-dynamic";

export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[] }>;
}) {
  let scopeMode: "owner" | "assisted" | null = "owner";
  try {
    const params = await searchParams;
    const requestedScope = params.scope;
    if (requestedScope === "assisted") scopeMode = "assisted";
    else if (requestedScope !== undefined) scopeMode = null;
    const token = (await cookies()).get(PARTICIPANT_COOKIE)?.value;
    const session = verifyParticipantSession(token);
    if (!session || !(await findParticipantById(session.id))) {
      return <ResultsPanel initial={{ state: "unauthenticated" }} scope={scopeMode} />;
    }
    if (scopeMode === null) {
      return <ResultsPanel initial={{ state: "unavailable" }} scope={scopeMode} />;
    }

    const scope = await resolveAnswerScope(
      session.id,
      scopeMode === "assisted" ? "assisted" : null,
    );
    if ("error" in scope) {
      return <ResultsPanel initial={{ state: "unavailable" }} scope={scopeMode} />;
    }

    const assistedTarget = scopeMode === "owner" ? await getAssistedParticipant(session.id) : null;
    const hasAssistedSubmission = assistedTarget
      ? Boolean(await getLatestAnswerSubmission(assistedTarget.id))
      : false;

    return (
      <Suspense fallback={<ResultsShell scope={scopeMode} />}>
        <ResultsContent
          participantId={scope.participantId}
          scope={scopeMode}
          hasAssistedSubmission={hasAssistedSubmission}
        />
      </Suspense>
    );
  } catch {
    // Fail closed with neutral content when the server cannot verify the session or visibility.
    return <ResultsPanel initial={{ state: "waiting" }} scope={scopeMode} />;
  }
}

async function ResultsContent({
  participantId,
  scope,
  hasAssistedSubmission,
}: {
  participantId: number;
  scope: "owner" | "assisted";
  hasAssistedSubmission: boolean;
}) {
  const result = await getParticipantResult(participantId);
  const initial: ParticipantResult =
    result.state === "visible"
      ? {
          state: "visible",
          rank: result.rank,
          participantCount: result.participantCount,
          score: result.score,
          maxScore: result.maxScore,
          questions: result.questions.map(({ position, question, answer }) => ({
            position,
            question,
            answer:
              answer.kind === "selected"
                ? {
                    kind: "selected" as const,
                    value: answer.value,
                    correctness: answer.correctness,
                  }
                : answer.kind === "freeText"
                  ? { kind: "freeText" as const, value: answer.value, score: answer.score }
                  : { kind: answer.kind },
          })),
        }
      : result;

  return (
    <ResultsPanel initial={initial} scope={scope} hasAssistedSubmission={hasAssistedSubmission} />
  );
}

function ResultsShell({ scope }: { scope: "owner" | "assisted" }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-12">
      <section
        aria-busy="true"
        className="min-h-[56rem] rounded-2xl border border-border bg-surface p-7 shadow-sm sm:p-10"
      >
        <p className="mb-3 text-sm font-semibold tracking-widest text-primary">しゅんたま検定</p>
        <h1 className="text-3xl font-bold tracking-tight">
          {scope === "assisted" ? "代理回答の結果" : "あなたの結果"}
        </h1>
        <p className="mt-8" role="status" aria-live="polite">
          結果を読み込んでいます。
        </p>
        <p className="mt-4 text-muted">
          結果が表示されるまで、このページを開いたままお待ちください。
        </p>
        <Link className="mt-8 inline-flex font-semibold text-primary underline" href="/answer">
          回答画面へ戻る
        </Link>
      </section>
    </main>
  );
}
