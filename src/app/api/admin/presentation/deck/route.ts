import { NextResponse } from "next/server";
import {
  isAdminPresentationAuthConfigured,
  isAdminPresentationRequest,
} from "@/lib/presentation/admin-auth";
import { getAdminPresentationDeck } from "@/lib/db/repository/presentation-repository";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store, private" };

export async function GET(request: Request) {
  if (!isAdminPresentationAuthConfigured()) {
    return NextResponse.json(
      { error: "Admin presentation is unavailable" },
      { status: 503, headers: noStore },
    );
  }
  if (!isAdminPresentationRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore });
  }
  try {
    return NextResponse.json(await getAdminPresentationDeck(), { headers: noStore });
  } catch {
    return NextResponse.json(
      { error: "Admin presentation is unavailable" },
      { status: 503, headers: noStore },
    );
  }
}
