import { NextResponse } from "next/server";
import {
  isAdminPresentationAuthConfigured,
  isAdminPresentationRequest,
  isValidAdminMutation,
} from "@/lib/presentation/admin-auth";
import {
  getAdminPresentation,
  getAdminPresentationControls,
  operatePresentationControls,
  PresentationConflictError,
} from "@/lib/db/repository/presentation-repository";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store, private" };

function unavailable() {
  return NextResponse.json(
    { error: "Admin presentation is unavailable" },
    { status: 503, headers: noStore },
  );
}

export async function GET(request: Request) {
  if (!isAdminPresentationAuthConfigured()) return unavailable();
  if (!isAdminPresentationRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
  }
  try {
    const url = new URL(request.url);
    const view = url.searchParams.get("view");
    const presentation =
      view === "controls" ? await getAdminPresentationControls() : await getAdminPresentation();
    return NextResponse.json(presentation, { headers: noStore });
  } catch {
    return unavailable();
  }
}

export async function POST(request: Request) {
  if (!isAdminPresentationAuthConfigured()) return unavailable();
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
  const value = body as {
    operationId?: unknown;
    action?: unknown;
    mode?: unknown;
  } | null;
  if (
    !value ||
    typeof value.operationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.operationId,
    ) ||
    (value.action !== "start" &&
      value.action !== "advance" &&
      value.action !== "previous" &&
      value.action !== "hide" &&
      value.action !== "show") ||
    value.mode !== undefined
  ) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: noStore });
  }
  try {
    const result = await operatePresentationControls(value.operationId, value.action);
    return NextResponse.json(
      {
        state: result.state,
        version: result.version,
        questionIndex: result.questionIndex,
        questionCount: result.questionCount,
        projectionHidden: result.projectionHidden,
      },
      {
        headers: noStore,
      },
    );
  } catch (error) {
    if (error instanceof PresentationConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409, headers: noStore });
    }
    return unavailable();
  }
}
