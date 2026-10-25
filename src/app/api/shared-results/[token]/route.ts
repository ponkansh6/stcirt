import { NextResponse } from "next/server";
import type { SharedParticipantResultResponse } from "@/lib/assisted-result-share-contract";
import {
  readRateLimitedSharedParticipantResult,
  sharedResultHeaders,
} from "@/lib/participants/assisted-result-sharing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext<"/api/shared-results/[token]">) {
  const headers = sharedResultHeaders();
  try {
    const { token } = await context.params;
    const outcome = await readRateLimitedSharedParticipantResult(token);
    if (outcome.state === "not_found")
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404, headers });
    const result: SharedParticipantResultResponse = outcome.result;
    return NextResponse.json(result, { headers });
  } catch {
    return NextResponse.json({ error: "RESULT_UNAVAILABLE" }, { status: 503, headers });
  }
}
