import { Suspense } from "react";
import { cookies } from "next/headers";
import Link from "next/link";
import ResultsPanel from "./results-panel";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import { getParticipantResult } from "@/lib/db/repository/presentation-repository";
import { mapParticipantResult } from "@/lib/participant-result-projection";
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
    if (!session) {
      return <ResultsPanel initial={{ state: "unauthenticated" }} scope={scopeMode} />;
    }
    const participant = await findParticipantById(session.id);
    if (!participant) {
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

    const assistedTarget = await getAssistedParticipant(session.id);
    const resultParticipant = scopeMode === "assisted" ? assistedTarget : participant;
    if (!resultParticipant || resultParticipant.id !== scope.participantId) {
      return <ResultsPanel initial={{ state: "unavailable" }} scope={scopeMode} />;
    }
    const hasAssistedSubmission =
      scopeMode === "assisted"
        ? Boolean(await getLatestAnswerSubmission(scope.participantId))
        : assistedTarget
          ? Boolean(await getLatestAnswerSubmission(assistedTarget.id))
          : false;

    return (
      <Suspense fallback={<ResultsShell scope={scopeMode} />}>
        <ResultsContent
          participantId={scope.participantId}
          participantName={resultParticipant.name}
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
  participantName,
  scope,
  hasAssistedSubmission,
}: {
  participantId: number;
  participantName: string;
  scope: "owner" | "assisted";
  hasAssistedSubmission: boolean;
}) {
  const result = await getParticipantResult(participantId);
  const initial = mapParticipantResult(result);

  return (
    <ResultsPanel
      initial={initial}
      participantName={participantName}
      scope={scope}
      hasAssistedSubmission={hasAssistedSubmission}
    />
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
