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
  setPresentationPosition,
  PresentationConflictError,
} from "@/lib/db/repository/presentation-repository";
import type { PresentationState } from "@/lib/db/repository/presentation-repository";

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
    expectedSnapshotRevision?: unknown;
    expectedSessionVersion?: unknown;
    state?: unknown;
    questionIndex?: unknown;
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
      value.action !== "position" &&
      value.action !== "hide" &&
      value.action !== "show" &&
      value.action !== "aggregate" &&
      value.action !== "reset") ||
    (value.expectedSnapshotRevision !== undefined &&
      (typeof value.expectedSnapshotRevision !== "number" ||
        !Number.isInteger(value.expectedSnapshotRevision) ||
        value.expectedSnapshotRevision < 0)) ||
    value.mode !== undefined ||
    (value.action === "position" &&
      (typeof value.state !== "string" ||
        ![
          "opening",
          "question",
          "answer",
          "podium_preview",
          "third",
          "second",
          "first",
          "first_prize",
          "finished",
        ].includes(value.state) ||
        typeof value.questionIndex !== "number" ||
        !Number.isInteger(value.questionIndex) ||
        value.questionIndex < 0 ||
        typeof value.expectedSnapshotRevision !== "number" ||
        typeof value.expectedSessionVersion !== "number" ||
        !Number.isInteger(value.expectedSessionVersion) ||
        value.expectedSessionVersion < 0))
  ) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: noStore });
  }
  try {
    const result: Awaited<ReturnType<typeof operatePresentationControls>> =
      value.action === "position"
        ? await setPresentationPosition(
            value.operationId,
            value.state as PresentationState,
            value.questionIndex as number,
            value.expectedSnapshotRevision as number,
            value.expectedSessionVersion as number,
          )
        : value.expectedSnapshotRevision === undefined
          ? await operatePresentationControls(value.operationId, value.action)
          : await operatePresentationControls(
              value.operationId,
              value.action,
              value.expectedSnapshotRevision,
            );
    return NextResponse.json(
      {
        state: result.state,
        version: result.version,
        snapshotRevision: result.snapshotRevision,
        questionIndex: result.questionIndex,
        questionCount: result.questionCount,
        projectionHidden: result.projectionHidden,
        ...(value.action === "aggregate" && result.aggregationSummary
          ? { aggregationSummary: result.aggregationSummary }
          : {}),
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
