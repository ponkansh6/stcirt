import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  ADMIN_PRESENTATION_COOKIE,
  createAdminPresentationSession,
  isAdminPresentationAuthConfigured,
  isAdminPresentationRequest,
  verifyAdminPresentationPin,
} from "@/lib/presentation/admin-auth";
import { requestHasValidOrigin } from "@/lib/participants/security";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store, private" };

export async function GET(request: Request) {
  return NextResponse.json(
    { authenticated: isAdminPresentationAuthConfigured() && isAdminPresentationRequest(request) },
    { headers: noStore },
  );
}

export async function POST(request: Request) {
  if (!requestHasValidOrigin(request)) {
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403, headers: noStore },
    );
  }
  if (!isAdminPresentationAuthConfigured()) {
    return NextResponse.json(
      { error: "Admin sign-in is unavailable" },
      { status: 503, headers: noStore },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: noStore });
  }
  const pin = body && typeof body === "object" ? (body as { pin?: unknown }).pin : undefined;
  if (!verifyAdminPresentationPin(pin)) {
    return NextResponse.json({ error: "Invalid PIN" }, { status: 401, headers: noStore });
  }
  const session = createAdminPresentationSession();
  if (!session) {
    return NextResponse.json(
      { error: "Admin sign-in is unavailable" },
      { status: 503, headers: noStore },
    );
  }
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_PRESENTATION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: session.maxAge,
    secure: process.env.NODE_ENV === "production",
  });
  return NextResponse.json({ authenticated: true }, { headers: noStore });
}

export async function DELETE(request: Request) {
  if (!requestHasValidOrigin(request)) {
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403, headers: noStore },
    );
  }
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_PRESENTATION_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    expires: new Date(0),
    maxAge: 0,
    secure: process.env.NODE_ENV === "production",
  });
  return NextResponse.json({ authenticated: false }, { headers: noStore });
}
