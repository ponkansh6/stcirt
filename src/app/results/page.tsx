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
      initial = await getParticipantResult(session.id);
    }
  } catch {
    // Fail closed with neutral content when the server cannot verify the session or visibility.
  }
  return <ResultsPanel initial={initial} />;
}
