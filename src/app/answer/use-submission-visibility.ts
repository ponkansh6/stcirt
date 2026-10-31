"use client";

import { useEffect, useState } from "react";
import type { AccessState, AnswerMode, Phase } from "./use-quiz-session";

export type VisibilityStatus = "unknown" | "locked" | "unlocked";
export type SubmissionVisibilitySnapshot = { key: string; status: VisibilityStatus };

export function makeSubmissionVisibilityKey({
  participantId,
  answerMode,
  assistedParticipantId,
  submissionId,
  revision,
}: {
  participantId: number | null;
  answerMode: AnswerMode;
  assistedParticipantId: number | undefined;
  submissionId: string | null;
  revision: number;
}) {
  return [
    participantId ?? "unauthenticated",
    answerMode,
    answerMode === "assisted" ? (assistedParticipantId ?? "missing-target") : "owner",
    submissionId ?? "missing-submission",
    revision,
  ].join(":");
}

/** Owns the scoped saved-submission visibility check used to guard answer edits. */
export function useSubmissionVisibility(
  {
    access,
    answerMode,
    assistedParticipantId,
    submissionId,
    revision,
    phase,
    clearPublishedLock,
  }: {
    access: AccessState;
    answerMode: AnswerMode;
    assistedParticipantId: number | undefined;
    submissionId: string | null;
    revision: number;
    phase: Phase;
    clearPublishedLock?: () => void;
  },
  liveSnapshotRef?: { current: SubmissionVisibilitySnapshot | null },
) {
  const [submissionVisibility, setSubmissionVisibility] = useState<{
    key: string;
    status: VisibilityStatus;
  } | null>(null);
  const accessKind = access.kind;
  const participantId = access.kind === "ready" ? access.participant.id : null;
  const currentVisibilityKey = makeSubmissionVisibilityKey({
    participantId,
    answerMode,
    assistedParticipantId,
    submissionId,
    revision,
  });
  const visibilityStatus =
    submissionVisibility?.key === currentVisibilityKey ? submissionVisibility.status : "unknown";
  if (liveSnapshotRef && liveSnapshotRef.current?.key !== currentVisibilityKey) {
    liveSnapshotRef.current = { key: currentVisibilityKey, status: "unknown" };
  }

  useEffect(() => {
    const editingSubmission = phase.kind === "answering" || phase.kind === "complete";
    const visibilityKey = currentVisibilityKey;
    const markVisibilityUnknown = () => {
      if (liveSnapshotRef) liveSnapshotRef.current = { key: visibilityKey, status: "unknown" };
      setSubmissionVisibility((current) =>
        current?.key === visibilityKey && current.status === "unknown"
          ? current
          : { key: visibilityKey, status: "unknown" },
      );
    };
    if (!submissionId || revision === 0 || !editingSubmission || accessKind !== "ready") {
      markVisibilityUnknown();
      return;
    }
    let active = true;
    let pending = false;
    const refreshLock = async () => {
      if (pending) return;
      pending = true;
      try {
        const scope = answerMode === "assisted" ? "&scope=assisted" : "";
        const response = await fetch(
          `/api/answers/visibility?submissionId=${encodeURIComponent(submissionId)}${scope}`,
          { cache: "no-store", credentials: "same-origin" },
        );
        if (!active) return;
        if (!response.ok) throw new Error("Visibility lookup failed");
        const payload: unknown = await response.json();
        if (!active) return;
        if (typeof payload !== "object" || payload === null) {
          markVisibilityUnknown();
          return;
        }
        const resultsVisible = (payload as { resultsVisible?: unknown }).resultsVisible;
        if (typeof resultsVisible === "boolean") {
          const status = resultsVisible ? "locked" : "unlocked";
          if (liveSnapshotRef) liveSnapshotRef.current = { key: visibilityKey, status };
          setSubmissionVisibility({
            key: visibilityKey,
            status,
          });
          if (!resultsVisible) clearPublishedLock?.();
        } else {
          markVisibilityUnknown();
        }
      } catch {
        if (active) markVisibilityUnknown();
      } finally {
        pending = false;
      }
    };
    void refreshLock();
    const interval = window.setInterval(() => void refreshLock(), 60_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshLock();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    accessKind,
    answerMode,
    assistedParticipantId,
    clearPublishedLock,
    phase.kind,
    liveSnapshotRef,
    participantId,
    revision,
    submissionId,
    currentVisibilityKey,
  ]);

  return visibilityStatus;
}
