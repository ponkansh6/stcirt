"use client";

import { useEffect, useState } from "react";
import type { AccessState, AnswerMode, Phase } from "./use-quiz-session";

type VisibilityStatus = "unknown" | "locked" | "unlocked";

/** Owns the scoped saved-submission visibility check used to guard answer edits. */
export function useSubmissionVisibility({
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
}) {
  const [submissionVisibility, setSubmissionVisibility] = useState<{
    key: string;
    status: VisibilityStatus;
  } | null>(null);
  const accessKind = access.kind;
  const participantId = access.kind === "ready" ? access.participant.id : null;
  const currentVisibilityKey = [
    participantId ?? "unauthenticated",
    answerMode,
    answerMode === "assisted" ? (assistedParticipantId ?? "missing-target") : "owner",
    submissionId ?? "missing-submission",
  ].join(":");
  const visibilityStatus =
    submissionVisibility?.key === currentVisibilityKey ? submissionVisibility.status : "unknown";

  useEffect(() => {
    const editingSubmission = phase.kind === "answering" || phase.kind === "complete";
    const visibilityKey = currentVisibilityKey;
    const markVisibilityUnknown = () =>
      setSubmissionVisibility((current) =>
        current?.key === visibilityKey && current.status === "unknown"
          ? current
          : { key: visibilityKey, status: "unknown" },
      );
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
          `/api/answers/batch?submissionId=${encodeURIComponent(submissionId)}${scope}`,
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
          setSubmissionVisibility({
            key: visibilityKey,
            status: resultsVisible ? "locked" : "unlocked",
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
    const interval = window.setInterval(() => void refreshLock(), 30_000);
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
    participantId,
    revision,
    submissionId,
    currentVisibilityKey,
  ]);

  return visibilityStatus;
}
