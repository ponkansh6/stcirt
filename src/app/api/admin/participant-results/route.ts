import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  setParticipantResultsVisible,
  PresentationConflictError,
} from "@/lib/db/repository/presentation-repository";
import {
  isAdminPresentationAuthConfigured,
  isAdminPresentationRequest,
  isValidAdminMutation,
} from "@/lib/presentation/admin-auth";
import { getPresentationOperationDiagnostics } from "@/lib/presentation/operation-diagnostics";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store, private" };

export async function POST(request: Request) {
  if (!isAdminPresentationAuthConfigured()) {
    return NextResponse.json(
      { error: "Admin presentation is unavailable" },
      { status: 503, headers: noStore },
    );
  }
  if (!isValidAdminMutation(request)) {
    const status = isAdminPresentationRequest(request) ? 403 : 401;
    return NextResponse.json(
      { error: status === 401 ? "Unauthorized" : "Invalid request origin" },
      { status, headers: noStore },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: noStore });
  }
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { visible?: unknown }).visible !== "boolean"
  ) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: noStore });
  }
  try {
    return NextResponse.json(
      await setParticipantResultsVisible((body as { visible: boolean }).visible),
      { headers: noStore },
    );
  } catch (error) {
    if (error instanceof PresentationConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409, headers: noStore });
    }
    const vercelRequestId = getVercelRequestId(request);
    const diagnostics = getPresentationOperationDiagnostics(error);
    console.error(
      JSON.stringify({
        event: "admin_participant_results_failed",
        vercelRequestId,
        phase: diagnostics?.phase ?? "unclassified",
        errorKind: diagnostics?.errorKind ?? "unknown",
        databaseCode: diagnostics?.databaseCode ?? null,
      }),
    );
    return NextResponse.json(
      { error: "Admin presentation is unavailable" },
      { status: 503, headers: noStore },
    );
  }
}

function getVercelRequestId(request: Request) {
  const value = request.headers.get("x-vercel-id");
  if (value && /^[A-Za-z0-9:_-]{1,128}$/.test(value)) return value;
  return `generated:${randomUUID()}`;
}
