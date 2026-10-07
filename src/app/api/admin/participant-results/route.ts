import { NextResponse } from "next/server";
import {
  setParticipantResultsVisible,
  PresentationConflictError,
} from "@/lib/db/repository/presentation-repository";
import {
  isAdminPresentationAuthConfigured,
  isAdminPresentationRequest,
  isValidAdminMutation,
} from "@/lib/presentation/admin-auth";

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
    return NextResponse.json(
      { error: "Admin presentation is unavailable" },
      { status: 503, headers: noStore },
    );
  }
}
