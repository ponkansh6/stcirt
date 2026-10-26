"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseParticipantResult } from "@/lib/participant-results-contract";
import type { AccessState, AnswerMode, Phase } from "./use-quiz-session";

/** Owns the complete-result CTA visibility refresh and its authenticated scope. */
export function useParticipantResultsVisibility(
  phase: Phase,
  access: AccessState,
  answerMode: AnswerMode,
) {
  const [result, setResult] = useState<{
    key: string;
    phase: Phase;
    epoch: number;
    status: "confirmed" | "reauthentication";
    visible: boolean;
  } | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const generationRef = useRef(0);
  const readyParticipantId = access.kind === "ready" ? access.participant.id : null;
  const activeKey =
    phase.kind === "complete" && readyParticipantId !== null
      ? `${readyParticipantId}:${answerMode}`
      : null;
  const isReadyTarget = activeKey !== null && access.kind === "ready";
  const targetIdentityRef = useRef({
    key: activeKey,
    phase,
    isReady: isReadyTarget,
    epoch: 0,
  });
  const previousTarget = targetIdentityRef.current;
  if (
    previousTarget.key !== activeKey ||
    previousTarget.phase !== phase ||
    previousTarget.isReady !== isReadyTarget
  ) {
    targetIdentityRef.current = {
      key: activeKey,
      phase,
      isReady: isReadyTarget,
      epoch: previousTarget.epoch + 1,
    };
  }
  const targetEpoch = targetIdentityRef.current.epoch;
  const currentResult =
    result?.key === activeKey && result.phase === phase && result.epoch === targetEpoch
      ? result
      : null;
  const clearAuthExpired = useCallback(() => {
    setResult(null);
    setRefreshGeneration((current) => current + 1);
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    const isCurrent = () => generation === generationRef.current;
    if (activeKey === null || access.kind !== "ready") return;
    let active = true;
    let pending = false;
    let refreshQueued = false;
    let requestRevision = 0;
    const refresh = async () => {
      if (pending) {
        refreshQueued = true;
        requestRevision += 1;
        return;
      }
      pending = true;
      const currentRevision = ++requestRevision;
      try {
        const resultsUrl =
          answerMode === "assisted"
            ? "/api/participants/results?scope=assisted"
            : "/api/participants/results";
        const response = await fetch(resultsUrl, {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!active || !isCurrent() || currentRevision !== requestRevision) return;
        if (response.status === 401) {
          setResult({
            key: activeKey,
            phase,
            epoch: targetEpoch,
            status: "reauthentication",
            visible: false,
          });
          return;
        }
        if (!response.ok) return;
        const result = parseParticipantResult(await response.json());
        if (active && isCurrent() && currentRevision === requestRevision) {
          if (!result) return;
          setResult({
            key: activeKey,
            phase,
            epoch: targetEpoch,
            status: "confirmed",
            visible: result.state === "visible",
          });
        }
      } catch {
        // Keep the last confirmed CTA state when a refresh fails.
      } finally {
        pending = false;
        if (active && refreshQueued) {
          refreshQueued = false;
          void refresh();
        }
      }
    };
    void refresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      generationRef.current += Number(isCurrent());
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [access.kind, activeKey, answerMode, phase, refreshGeneration, targetEpoch]);

  return {
    status: currentResult?.status ?? (activeKey === null ? "inactive" : "unknown"),
    visible: currentResult?.status === "confirmed" && currentResult.visible,
    authExpired: currentResult?.status === "reauthentication",
    clearAuthExpired,
  };
}
