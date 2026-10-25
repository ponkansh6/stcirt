import type { ParticipantResult } from "./participant-results-contract";

export type AssistedResultShareState = {
  exists: boolean;
  issuedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
};

export type AssistedResultShareIssue = {
  path: `/shared-results/${string}`;
  issuedAt: string;
  expiresAt: string;
};

export type AssistedResultShareStop = { stopped: true };
export type SharedParticipantResultResponse = ParticipantResult;

export function isAssistedResultShareState(value: unknown): value is AssistedResultShareState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.exists === "boolean" &&
    (state.issuedAt === null || typeof state.issuedAt === "string") &&
    (state.expiresAt === null || typeof state.expiresAt === "string") &&
    typeof state.expired === "boolean"
  );
}
