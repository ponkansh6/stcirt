import { NextResponse } from "next/server";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import { getParticipantResult } from "@/lib/db/repository/presentation-repository";
import { getParticipantCookie, verifyParticipantSession } from "@/lib/participants/security";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const session = verifyParticipantSession(getParticipantCookie(request));
  if (!session || !(await findParticipantById(session.id))) {
    return NextResponse.json(
      { error: "Participant session required" },
      { status: 401, headers: noStore },
    );
  }
  try {
    const result = await getParticipantResult(session.id);
    if (result.state === "visible") {
      const questions = result.questions.map(({ position, question, answer }) => ({
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
      }));
      return NextResponse.json(
        { state: "visible", rank: result.rank, score: result.score, questions },
        { headers: noStore },
      );
    }
    return NextResponse.json(result, { headers: noStore });
  } catch {
    return NextResponse.json(
      { error: "Results are unavailable" },
      { status: 503, headers: noStore },
    );
  }
}
