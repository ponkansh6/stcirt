"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AccessState, AnswerMode, Phase } from "./use-quiz-session";

export type VisibilityStatus = "unknown" | "locked" | "unlocked";
export type SubmissionVisibilityLookupStatus = "inactive" | "pending" | "settled" | "error";
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
  const [visibilityLookup, setVisibilityLookup] = useState<{
    key: string;
    status: SubmissionVisibilityLookupStatus;
  } | null>(null);
  const consumedSeedRef = useRef<{
    key: string;
    snapshot: NonNullable<Extract<Phase, { kind: "complete" }>["completionSnapshot"]>;
  } | null>(null);
  const observedSnapshotRef = useRef<{
    key: string;
    snapshot: NonNullable<Extract<Phase, { kind: "complete" }>["completionSnapshot"]>;
  } | null>(null);
  const recheckRequestRef = useRef<{ key: string; run: () => Promise<boolean> } | null>(null);
  const accessKind = access.kind;
  const participantId = access.kind === "ready" ? access.participant.id : null;
  const currentVisibilityKey = makeSubmissionVisibilityKey({
    participantId,
    answerMode,
    assistedParticipantId,
    submissionId,
    revision,
  });
  const currentVisibilityKeyRef = useRef(currentVisibilityKey);
  currentVisibilityKeyRef.current = currentVisibilityKey;
  const ownerParticipantId = access.kind === "ready" ? access.participant.id : null;
  const completionSnapshot = phase.kind === "complete" ? phase.completionSnapshot : undefined;
  const snapshotIdentity = completionSnapshot?.identity;
  const seededStatus: VisibilityStatus | null =
    completionSnapshot?.status === "ready" &&
    ownerParticipantId !== null &&
    snapshotIdentity?.scope === answerMode &&
    snapshotIdentity.ownerParticipantId === ownerParticipantId &&
    snapshotIdentity.participantId ===
      (answerMode === "assisted" ? assistedParticipantId : ownerParticipantId) &&
    snapshotIdentity.submissionId === submissionId &&
    snapshotIdentity.revision === revision &&
    (completionSnapshot.resultsState === "waiting") === !completionSnapshot.resultsVisible
      ? completionSnapshot.resultsVisible
        ? "locked"
        : "unlocked"
      : null;
  const candidateSnapshot =
    seededStatus === null || completionSnapshot?.status !== "ready" ? null : completionSnapshot;
  const candidateSeed =
    seededStatus === null ? null : { key: currentVisibilityKey, status: seededStatus };
  const seed =
    candidateSeed !== null &&
    candidateSnapshot !== null &&
    (consumedSeedRef.current?.key !== currentVisibilityKey ||
      consumedSeedRef.current.snapshot !== candidateSnapshot)
      ? candidateSeed
      : null;
  const seedForEffectRef = useRef(seed);
  seedForEffectRef.current = seed;
  const newInvalidSnapshot =
    completionSnapshot !== undefined &&
    seededStatus === null &&
    (observedSnapshotRef.current === null ||
      observedSnapshotRef.current.key !== currentVisibilityKey ||
      observedSnapshotRef.current.snapshot !== completionSnapshot);
  const currentVisibility =
    !newInvalidSnapshot && submissionVisibility?.key === currentVisibilityKey
      ? submissionVisibility
      : null;
  const currentVisibilityForEffectRef = useRef(currentVisibility);
  currentVisibilityForEffectRef.current = currentVisibility;
  const visibilityStatus =
    seed !== null
      ? seed.status
      : currentVisibility && currentVisibility.status !== "unknown"
        ? currentVisibility.status
        : (currentVisibility?.status ?? "unknown");
  const activeVisibilityCheck =
    (phase.kind === "answering" || phase.kind === "complete") &&
    Boolean(submissionId) &&
    revision > 0 &&
    accessKind === "ready";
  const lookupStatus =
    seed !== null
      ? "settled"
      : newInvalidSnapshot
        ? "pending"
        : visibilityLookup?.key === currentVisibilityKey
          ? visibilityLookup.status
          : currentVisibility && currentVisibility.status !== "unknown"
            ? "settled"
            : activeVisibilityCheck
              ? "pending"
              : "inactive";
  const recheck = useCallback(async () => {
    const request = recheckRequestRef.current;
    if (!activeVisibilityCheck || request?.key !== currentVisibilityKey) return false;
    return request.run();
  }, [activeVisibilityCheck, currentVisibilityKey]);
  if (liveSnapshotRef && liveSnapshotRef.current?.key !== currentVisibilityKey) {
    liveSnapshotRef.current = seed ?? { key: currentVisibilityKey, status: "unknown" };
  } else if (liveSnapshotRef && newInvalidSnapshot) {
    liveSnapshotRef.current = { key: currentVisibilityKey, status: "unknown" };
  } else if (liveSnapshotRef && seed !== null) {
    liveSnapshotRef.current = seed;
  }

  useEffect(() => {
    const editingSubmission = phase.kind === "answering" || phase.kind === "complete";
    const visibilityKey = currentVisibilityKey;
    const effectSeed = seedForEffectRef.current;
    const effectCurrentVisibility = currentVisibilityForEffectRef.current;
    const previousObservedSnapshot = observedSnapshotRef.current;
    const isNewRawSnapshot =
      completionSnapshot !== undefined &&
      (previousObservedSnapshot === null ||
        previousObservedSnapshot.key !== visibilityKey ||
        previousObservedSnapshot.snapshot !== completionSnapshot);
    if (completionSnapshot !== undefined) {
      observedSnapshotRef.current = { key: visibilityKey, snapshot: completionSnapshot };
    }
    let hasConfirmedVisibility =
      effectSeed !== null ||
      (effectCurrentVisibility?.key === visibilityKey &&
        effectCurrentVisibility.status !== "unknown");
    const markVisibilityUnknown = (lookupStatus: "inactive" | "error") => {
      hasConfirmedVisibility = false;
      if (liveSnapshotRef) liveSnapshotRef.current = { key: visibilityKey, status: "unknown" };
      setSubmissionVisibility((current) =>
        current?.key === visibilityKey && current.status === "unknown"
          ? current
          : { key: visibilityKey, status: "unknown" },
      );
      setVisibilityLookup({ key: visibilityKey, status: lookupStatus });
    };
    if (!submissionId || revision === 0 || !editingSubmission || accessKind !== "ready") {
      recheckRequestRef.current = null;
      markVisibilityUnknown("inactive");
      return;
    }
    if (effectSeed) {
      if (candidateSnapshot) {
        consumedSeedRef.current = { key: visibilityKey, snapshot: candidateSnapshot };
      }
      setSubmissionVisibility(effectSeed);
      setVisibilityLookup({ key: visibilityKey, status: "settled" });
      hasConfirmedVisibility = true;
      if (liveSnapshotRef) liveSnapshotRef.current = effectSeed;
      if (effectSeed.status === "unlocked") clearPublishedLock?.();
    } else if (isNewRawSnapshot) {
      hasConfirmedVisibility = false;
      if (liveSnapshotRef) liveSnapshotRef.current = { key: visibilityKey, status: "unknown" };
      setSubmissionVisibility({ key: visibilityKey, status: "unknown" });
      setVisibilityLookup({ key: visibilityKey, status: "pending" });
    }
    let active = true;
    let pendingRefresh: Promise<boolean> | null = null;
    let lastResumeRefreshAt: number | null = null;
    const refreshLock = (force = false): Promise<boolean> => {
      if (!active || currentVisibilityKeyRef.current !== visibilityKey) {
        return Promise.resolve(false);
      }
      if (pendingRefresh !== null) return pendingRefresh;
      const request = (async () => {
        if (force) {
          hasConfirmedVisibility = false;
          if (liveSnapshotRef) liveSnapshotRef.current = { key: visibilityKey, status: "unknown" };
          setSubmissionVisibility({ key: visibilityKey, status: "unknown" });
          setVisibilityLookup({ key: visibilityKey, status: "pending" });
        } else if (!hasConfirmedVisibility) {
          setVisibilityLookup({ key: visibilityKey, status: "pending" });
        }
        try {
          const scope = answerMode === "assisted" ? "&scope=assisted" : "";
          const response = await fetch(
            `/api/answers/visibility?submissionId=${encodeURIComponent(submissionId)}${scope}`,
            { cache: "no-store", credentials: "same-origin" },
          );
          if (!active || currentVisibilityKeyRef.current !== visibilityKey) return false;
          if (!response.ok) throw new Error("Visibility lookup failed");
          const payload: unknown = await response.json();
          if (!active || currentVisibilityKeyRef.current !== visibilityKey) return false;
          if (typeof payload !== "object" || payload === null) {
            markVisibilityUnknown("error");
            return false;
          }
          const resultsVisible = (payload as { resultsVisible?: unknown }).resultsVisible;
          if (typeof resultsVisible === "boolean") {
            const status = resultsVisible ? "locked" : "unlocked";
            if (liveSnapshotRef) liveSnapshotRef.current = { key: visibilityKey, status };
            setSubmissionVisibility({
              key: visibilityKey,
              status,
            });
            setVisibilityLookup({ key: visibilityKey, status: "settled" });
            hasConfirmedVisibility = true;
            if (!resultsVisible) clearPublishedLock?.();
            return !resultsVisible;
          }
          markVisibilityUnknown("error");
          return false;
        } catch {
          if (active && currentVisibilityKeyRef.current === visibilityKey) {
            markVisibilityUnknown("error");
          }
          return false;
        }
      })();
      pendingRefresh = request;
      void request.then(
        () => {
          if (pendingRefresh === request) pendingRefresh = null;
        },
        () => {
          if (pendingRefresh === request) pendingRefresh = null;
        },
      );
      return request;
    };
    recheckRequestRef.current = {
      key: visibilityKey,
      run: () => refreshLock(true),
    };
    if (!effectSeed && (!hasConfirmedVisibility || isNewRawSnapshot)) void refreshLock();
    const interval = window.setInterval(() => void refreshLock(), 60_000);
    const refreshOnResume = () => {
      const now = Date.now();
      if (lastResumeRefreshAt !== null && now - lastResumeRefreshAt < 1_000) return;
      lastResumeRefreshAt = now;
      void refreshLock();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshOnResume();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) refreshOnResume();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      active = false;
      if (recheckRequestRef.current?.key === visibilityKey) recheckRequestRef.current = null;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
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
    candidateSeed?.key,
    candidateSeed?.status,
    candidateSnapshot,
    completionSnapshot,
  ]);

  return { status: visibilityStatus, lookupStatus, recheck };
}
