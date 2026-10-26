import { cookies } from "next/headers";
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
  let resolvedResult: {
    participantId: number;
    participantName: string;
    scope: "owner" | "assisted";
    hasAssistedSubmission: boolean;
  };
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

    resolvedResult = {
      participantId: scope.participantId,
      participantName: resultParticipant.name,
      scope: scopeMode,
      hasAssistedSubmission,
    };
  } catch {
    // Fail closed with neutral content when the server cannot verify the session or visibility.
    return <ResultsPanel initial={{ state: "waiting" }} scope={scopeMode} />;
  }

  // Keep the protected lookup outside the fail-closed authorization block. Unexpected
  // repository or mapping failures must reach the route error boundary.
  const result = await getParticipantResult(resolvedResult.participantId);
  const initial = mapParticipantResult(result);

  return (
    <ResultsPanel
      initial={initial}
      participantName={resolvedResult.participantName}
      scope={resolvedResult.scope}
      hasAssistedSubmission={resolvedResult.hasAssistedSubmission}
    />
  );
}
