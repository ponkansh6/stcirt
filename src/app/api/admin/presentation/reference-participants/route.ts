import { NextResponse } from "next/server";
import {
  getPresentationReferenceNames,
  setPresentationReferenceNames,
} from "@/lib/db/repository/presentation-repository";
import {
  isAdminPresentationAuthConfigured,
  isAdminPresentationRequest,
  isValidAdminMutation,
} from "@/lib/presentation/admin-auth";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store, private" };
const maxNames = 500;
const maxNameLength = 120;
const maxInputLength = maxNames * (maxNameLength + 2);

function unavailable() {
  return NextResponse.json(
    { error: "Admin presentation is unavailable" },
    { status: 503, headers: noStore },
  );
}

function unauthorized(request: Request) {
  const status = isAdminPresentationRequest(request) ? 403 : 401;
  return NextResponse.json(
    { error: status === 401 ? "Unauthorized" : "Invalid request origin" },
    { status, headers: noStore },
  );
}

export async function GET(request: Request) {
  if (!isAdminPresentationAuthConfigured()) return unavailable();
  if (!isAdminPresentationRequest(request)) return unauthorized(request);
  try {
    return NextResponse.json(
      { names: await getPresentationReferenceNames() },
      { headers: noStore },
    );
  } catch {
    return unavailable();
  }
}

export async function PUT(request: Request) {
  if (!isAdminPresentationAuthConfigured()) return unavailable();
  if (!isValidAdminMutation(request)) return unauthorized(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: noStore });
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !("namesText" in body) ||
    typeof body.namesText !== "string" ||
    body.namesText.length > maxInputLength
  ) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: noStore });
  }

  const names = body.namesText.split(/\r?\n/).filter((name) => name.trim().length > 0);
  if (names.length > maxNames || names.some((name) => name.length > maxNameLength)) {
    return NextResponse.json(
      { error: `氏名は1行${maxNameLength}文字以内、${maxNames}件以内で入力してください。` },
      { status: 400, headers: noStore },
    );
  }

  try {
    const savedNames = await setPresentationReferenceNames(names);
    return NextResponse.json({ names: savedNames }, { headers: noStore });
  } catch {
    return unavailable();
  }
}
