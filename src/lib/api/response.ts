import { NextResponse } from "next/server";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

export function fail(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export function withErrorHandling(
  handler: (request: Request, context?: unknown) => Promise<NextResponse>,
  label: string,
) {
  return async function (request: Request, context?: unknown): Promise<NextResponse> {
    try {
      return await handler(request, context);
    } catch (error) {
      console.error(`Error in ${label}:`, error);
      return fail("Internal server error", 500);
    }
  };
}
