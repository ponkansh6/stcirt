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
  const [visible, setVisible] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const generationRef = useRef(0);
  const clearAuthExpired = useCallback(() => setAuthExpired(false), []);
  const readyParticipantId = access.kind === "ready" ? access.participant.id : null;

  useEffect(() => {
    const generation = ++generationRef.current;
    const isCurrent = () => generation === generationRef.current;
    if (phase.kind !== "complete" || access.kind !== "ready") {
      setVisible(false);
      setAuthExpired(false);
      return;
    }
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
          setVisible(false);
          setAuthExpired(true);
          return;
        }
        if (!response.ok) return;
        const result = parseParticipantResult(await response.json());
        if (active && isCurrent() && currentRevision === requestRevision) {
          if (!result) return;
          setVisible(result.state === "visible");
          setAuthExpired(false);
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
  }, [access.kind, answerMode, phase.kind, readyParticipantId]);

  return { visible, authExpired, clearAuthExpired };
}
