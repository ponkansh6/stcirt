import { NextResponse } from "next/server";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import { getParticipantResult } from "@/lib/db/repository/presentation-repository";
import { mapParticipantResult } from "@/lib/participant-result-projection";
import { resolveAnswerScope } from "@/lib/participants/answer-scope";
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
    const scope = await resolveAnswerScope(
      session.id,
      new URL(request.url).searchParams.get("scope"),
    );
    if ("error" in scope) {
      return NextResponse.json({ error: scope.error }, { status: scope.status, headers: noStore });
    }
    const result = await getParticipantResult(scope.participantId);
    return NextResponse.json(mapParticipantResult(result), { headers: noStore });
  } catch {
    return NextResponse.json(
      { error: "Results are unavailable" },
      { status: 503, headers: noStore },
    );
  }
}
