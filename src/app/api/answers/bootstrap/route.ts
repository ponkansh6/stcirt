import { NextResponse } from "next/server";
import { answerBootstrapSchema } from "@/lib/api/schemas";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import {
  AnswerBootstrapError,
  getAnswerBootstrap,
  type AnswerBootstrapMode,
} from "@/lib/participants/answer-bootstrap";
import { getParticipantCookie, verifyParticipantSession } from "@/lib/participants/security";

const privateNoStoreHeaders = { "Cache-Control": "private, no-store" };

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: privateNoStoreHeaders });
}

export async function GET(request: Request) {
  try {
    const modeValues = new URL(request.url).searchParams.getAll("mode");
    const mode = modeValues[0];
    if (modeValues.length !== 1 || (mode !== "owner" && mode !== "assisted")) {
      return json({ error: "Invalid answer bootstrap mode" }, 400);
    }

    const session = verifyParticipantSession(getParticipantCookie(request));
    if (!session) return json({ error: "Participant session required" }, 401);

    const owner = await findParticipantById(session.id);
    if (!owner) return json({ error: "Participant session required" }, 401);

    const result = await getAnswerBootstrap(owner, mode as AnswerBootstrapMode);
    return json(answerBootstrapSchema.parse(result));
  } catch (error) {
    if (error instanceof AnswerBootstrapError) {
      return json({ error: error.message }, error.status);
    }
    console.error("Error in GET /api/answers/bootstrap:", error);
    return json({ error: "Internal server error" }, 500);
  }
}
