import { NextResponse } from "next/server";
import { getPublicPresentation } from "@/lib/db/repository/presentation-repository";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await getPublicPresentation(), {
      headers: { "Cache-Control": "no-store, private" },
    });
  } catch {
    return NextResponse.json(
      { error: "Presentation is unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store, private" } },
    );
  }
}
