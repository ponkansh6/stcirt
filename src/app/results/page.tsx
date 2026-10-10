import { cookies } from "next/headers";
import ResultsPanel from "./results-panel";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import {
  getParticipantResult,
  type ParticipantResult,
} from "@/lib/db/repository/presentation-repository";
import { resolveAnswerScope } from "@/lib/participants/answer-scope";
import { PARTICIPANT_COOKIE, verifyParticipantSession } from "@/lib/participants/security";

export const dynamic = "force-dynamic";

export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[] }>;
}) {
  let initial: ParticipantResult | { state: "unauthenticated" } = { state: "waiting" };
  let scopeMode: "owner" | "assisted" | null = "owner";
  try {
    const params = await searchParams;
    const requestedScope = params.scope;
    if (requestedScope === "assisted") scopeMode = "assisted";
    else if (requestedScope !== undefined) scopeMode = null;
    const token = (await cookies()).get(PARTICIPANT_COOKIE)?.value;
    const session = verifyParticipantSession(token);
    if (!session || !(await findParticipantById(session.id))) {
      initial = { state: "unauthenticated" };
    } else if (scopeMode === null) {
      initial = { state: "unavailable" };
    } else {
      const scope = await resolveAnswerScope(
        session.id,
        scopeMode === "assisted" ? "assisted" : null,
      );
      const result =
        "error" in scope
          ? { state: "unavailable" as const }
          : await getParticipantResult(scope.participantId);
      initial =
        result.state === "visible"
          ? {
              state: "visible",
              rank: result.rank,
              score: result.score,
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
    }
  } catch {
    // Fail closed with neutral content when the server cannot verify the session or visibility.
  }
  return <ResultsPanel initial={initial} scope={scopeMode} />;
}
