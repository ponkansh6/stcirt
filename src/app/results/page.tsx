import { cookies } from "next/headers";
import ResultsPanel from "./results-panel";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import {
  getParticipantResult,
  type ParticipantResult,
} from "@/lib/db/repository/presentation-repository";
import { PARTICIPANT_COOKIE, verifyParticipantSession } from "@/lib/participants/security";

export const dynamic = "force-dynamic";

export default async function ResultsPage() {
  let initial: ParticipantResult | { state: "unauthenticated" } = { state: "waiting" };
  try {
    const token = (await cookies()).get(PARTICIPANT_COOKIE)?.value;
    const session = verifyParticipantSession(token);
    if (!session || !(await findParticipantById(session.id))) {
      initial = { state: "unauthenticated" };
    } else {
      const result = await getParticipantResult(session.id);
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
  return <ResultsPanel initial={initial} />;
}
