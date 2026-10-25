import { NextResponse } from "next/server";
import type {
  AssistedResultShareIssue,
  AssistedResultShareState,
  AssistedResultShareStop,
} from "@/lib/assisted-result-share-contract";
import { findParticipantById } from "@/lib/db/repository/participant-repository";
import {
  checkOwnerShareManagementRateLimit,
  checkOwnerShareStopRateLimit,
  getOwnerShare,
  issueAssistedResultShare,
  revokeAssistedResultShare,
  sharedResultHeaders,
} from "@/lib/participants/assisted-result-sharing";
import {
  getParticipantCookie,
  isParticipantAuthConfigured,
  requestHasValidOrigin,
  verifyParticipantSession,
} from "@/lib/participants/security";

export const runtime = "nodejs";
const json = <T>(body: T, status = 200) =>
  NextResponse.json(body, { status, headers: sharedResultHeaders() });

async function authorizedOwner(request: Request) {
  if (!isParticipantAuthConfigured()) return { error: json({ error: "UNAUTHORIZED" }, 401) };
  const session = verifyParticipantSession(getParticipantCookie(request));
  if (!session || !(await findParticipantById(session.id)))
    return { error: json({ error: "UNAUTHORIZED" }, 401) };
  return { ownerId: session.id };
}

export async function GET(request: Request) {
  const auth = await authorizedOwner(request);
  if ("error" in auth) return auth.error;
  if (!(await checkOwnerShareManagementRateLimit(auth.ownerId)))
    return json({ error: "RATE_LIMITED" }, 429);
  try {
    const { targetId, share } = await getOwnerShare(auth.ownerId);
    if (targetId === null) return json({ error: "NO_ASSISTED_TARGET" }, 404);
    const shareState: AssistedResultShareState = {
      exists: Boolean(share),
      issuedAt: share?.issuedAt.toISOString() ?? null,
      expiresAt: share?.expiresAt.toISOString() ?? null,
      expired: share ? share.expiresAt.getTime() <= Date.now() : false,
    };
    return json(shareState);
  } catch {
    return json({ error: "SHARE_UNAVAILABLE" }, 503);
  }
}

export async function POST(request: Request) {
  if (!requestHasValidOrigin(request)) return json({ error: "INVALID_ORIGIN" }, 403);
  const auth = await authorizedOwner(request);
  if ("error" in auth) return auth.error;
  if (!(await checkOwnerShareManagementRateLimit(auth.ownerId)))
    return json({ error: "RATE_LIMITED" }, 429);
  try {
    const result = await issueAssistedResultShare(auth.ownerId);
    if ("error" in result) {
      return json({ error: result.error }, result.error === "NO_ASSISTED_TARGET" ? 404 : 409);
    }
    const response: AssistedResultShareIssue = {
      path: `/shared-results/${result.token}`,
      issuedAt: result.issuedAt.toISOString(),
      expiresAt: result.expiresAt.toISOString(),
    };
    return json(response);
  } catch {
    return json({ error: "SHARE_UNAVAILABLE" }, 503);
  }
}

export async function DELETE(request: Request) {
  if (!requestHasValidOrigin(request)) return json({ error: "INVALID_ORIGIN" }, 403);
  const auth = await authorizedOwner(request);
  if ("error" in auth) return auth.error;
  if (!(await checkOwnerShareStopRateLimit(auth.ownerId)))
    return json({ error: "RATE_LIMITED" }, 429);
  try {
    await revokeAssistedResultShare(auth.ownerId);
    const response: AssistedResultShareStop = { stopped: true };
    return json(response);
  } catch {
    return json({ error: "SHARE_UNAVAILABLE" }, 503);
  }
}
