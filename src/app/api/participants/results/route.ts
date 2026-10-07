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
    return NextResponse.json(await getParticipantResult(session.id), { headers: noStore });
  } catch {
    return NextResponse.json(
      { error: "Results are unavailable" },
      { status: 503, headers: noStore },
    );
  }
}
