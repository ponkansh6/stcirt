"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseParticipantResult } from "@/lib/participant-results-contract";
import type { ParticipantResult } from "@/lib/participant-results-contract";
import type { AccessState, AnswerMode, Phase } from "./use-quiz-session";

type ParticipantResultState = ParticipantResult["state"];
type LookupStatus = "inactive" | "pending" | "retrying" | "retry-success" | "error" | "settled";

const LOOKUP_TIMEOUT_MS = 15_000;

/** Owns the complete-result CTA visibility refresh and its authenticated scope. */
export function useParticipantResultsVisibility(
  phase: Phase,
  access: AccessState,
  answerMode: AnswerMode,
) {
  const [result, setResult] = useState<{
    key: string;
    phaseKey: Phase["kind"];
    epoch: number;
    status: "confirmed" | "reauthentication";
    visible: boolean;
    state: ParticipantResultState | null;
  } | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const phaseKey = phase.kind;
  const [lookup, setLookup] = useState<{
    key: string;
    phaseKey: Phase["kind"];
    epoch: number;
    status: LookupStatus;
  }>({
    key: "",
    phaseKey,
    epoch: -1,
    status: "inactive",
  });
  const lookupRef = useRef<LookupStatus>("inactive");
  const retryRequestRef = useRef<(() => void) | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const readyParticipantId = access.kind === "ready" ? access.participant.id : null;
  const activeKey =
    phase.kind === "complete" && readyParticipantId !== null
      ? `${readyParticipantId}:${answerMode}`
      : null;
  const isReadyTarget = activeKey !== null && access.kind === "ready";
  const targetIdentityRef = useRef({
    key: activeKey,
    phaseKey,
    isReady: isReadyTarget,
    epoch: 0,
  });
  const previousTarget = targetIdentityRef.current;
  if (
    previousTarget.key !== activeKey ||
    previousTarget.phaseKey !== phaseKey ||
    previousTarget.isReady !== isReadyTarget
  ) {
    targetIdentityRef.current = {
      key: activeKey,
      phaseKey,
      isReady: isReadyTarget,
      epoch: previousTarget.epoch + 1,
    };
  }
  const targetEpoch = targetIdentityRef.current.epoch;
  const currentResult =
    result?.key === activeKey && result.phaseKey === phaseKey && result.epoch === targetEpoch
      ? result
      : null;
  const currentLookup =
    lookup.key === activeKey && lookup.phaseKey === phaseKey && lookup.epoch === targetEpoch
      ? lookup.status
      : activeKey === null
        ? "inactive"
        : "pending";
  const currentResultRef = useRef(currentResult);
  currentResultRef.current = currentResult;
  const retry = useCallback(() => {
    if (currentLookup !== "error" || currentResult) return;
    retryRequestRef.current?.();
  }, [currentLookup, currentResult]);
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
    let pendingSource: "initial" | "manual" | "visibility" | null = null;
    let visibilityRefreshQueued = false;
    let requestRevision = 0;
    let controller: AbortController | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let deadline = 0;
    let timeoutRevision = 0;
    let hasConfirmedResult = currentResultRef.current !== null;
    lookupRef.current = "pending";
    setLookup({ key: activeKey, phaseKey, epoch: targetEpoch, status: "pending" });
    const clearTimeoutTimer = () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = null;
    };
    const markInitialError = (revision: number) => {
      if (!active || !isCurrent() || revision !== requestRevision || hasConfirmedResult) return;
      lookupRef.current = "error";
      setLookup({ key: activeKey, phaseKey, epoch: targetEpoch, status: "error" });
    };
    const expireIfNeeded = (cause: "timer" | "resume" | "response") => {
      if (controller && pending && deadline > 0 && Date.now() >= deadline) {
        const expiredRevision = timeoutRevision;
        const shouldResumeConfirmedLookup =
          cause === "resume" && hasConfirmedResult && pendingSource !== "manual";
        controller.abort();
        if (shouldResumeConfirmedLookup) {
          if (!visibilityRefreshQueued) {
            visibilityRefreshQueued = true;
            requestRevision += 1;
          }
        } else {
          markInitialError(expiredRevision);
        }
        return true;
      }
      if (
        cause === "resume" &&
        pending &&
        pendingSource !== "manual" &&
        (hasConfirmedResult || lookupRef.current !== "error")
      ) {
        if (!visibilityRefreshQueued) {
          visibilityRefreshQueued = true;
          // A tab resume supersedes this GET; only the single queued lookup may confirm state.
          requestRevision += 1;
        }
      }
      return false;
    };
    const refresh = async (source: "initial" | "manual" | "visibility") => {
      if (pending) {
        return;
      }
      pending = true;
      pendingSource = source;
      if (!hasConfirmedResult) {
        const nextStatus = source === "manual" ? "retrying" : "pending";
        lookupRef.current = nextStatus;
        setLookup({ key: activeKey, phaseKey, epoch: targetEpoch, status: nextStatus });
      }
      const currentRevision = ++requestRevision;
      controller = new AbortController();
      controllerRef.current = controller;
      const requestController = controller;
      deadline = Date.now() + LOOKUP_TIMEOUT_MS;
      timeoutRevision = currentRevision;
      clearTimeoutTimer();
      timeoutId = setTimeout(() => expireIfNeeded("timer"), LOOKUP_TIMEOUT_MS);
      try {
        const resultsUrl =
          answerMode === "assisted"
            ? "/api/participants/results?scope=assisted"
            : "/api/participants/results";
        const response = await fetch(resultsUrl, {
          cache: "no-store",
          credentials: "same-origin",
          signal: requestController.signal,
        });
        if (expireIfNeeded("response")) return;
        if (!active || !isCurrent() || currentRevision !== requestRevision) return;
        if (response.status === 401) {
          lookupRef.current = "settled";
          setLookup({ key: activeKey, phaseKey, epoch: targetEpoch, status: "settled" });
          setResult({
            key: activeKey,
            phaseKey,
            epoch: targetEpoch,
            status: "reauthentication",
            visible: false,
            state: null,
          });
          return;
        }
        if (!response.ok) {
          markInitialError(currentRevision);
          return;
        }
        const result = parseParticipantResult(await response.json());
        if (expireIfNeeded("response")) return;
        if (active && isCurrent() && currentRevision === requestRevision) {
          if (!result) {
            markInitialError(currentRevision);
            return;
          }
          setResult({
            key: activeKey,
            phaseKey,
            epoch: targetEpoch,
            status: "confirmed",
            visible: result.state === "visible",
            state: result.state,
          });
          hasConfirmedResult = true;
          const nextStatus = source === "manual" ? "retry-success" : "settled";
          lookupRef.current = nextStatus;
          setLookup({ key: activeKey, phaseKey, epoch: targetEpoch, status: nextStatus });
        }
      } catch {
        markInitialError(currentRevision);
      } finally {
        clearTimeoutTimer();
        if (controllerRef.current === requestController) controllerRef.current = null;
        controller = null;
        deadline = 0;
        pending = false;
        pendingSource = null;
        if (active && visibilityRefreshQueued) {
          visibilityRefreshQueued = false;
          void refresh("visibility");
        }
      }
    };
    retryRequestRef.current = () => void refresh("manual");
    void refresh("initial");
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        const expired = expireIfNeeded("resume");
        if (expired || pending) return;
        if (!hasConfirmedResult && lookupRef.current === "error") return;
        void refresh("visibility");
      }
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      const expired = expireIfNeeded("resume");
      if (expired || pending) return;
      if (!hasConfirmedResult && lookupRef.current === "error") return;
      void refresh("visibility");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      active = false;
      clearTimeoutTimer();
      controller?.abort();
      if (controller && controllerRef.current === controller) controllerRef.current = null;
      retryRequestRef.current = null;
      generationRef.current += Number(isCurrent());
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [access.kind, activeKey, answerMode, phaseKey, refreshGeneration, targetEpoch]);

  return {
    status: currentResult?.status ?? (activeKey === null ? "inactive" : "unknown"),
    lookupStatus: currentLookup,
    retry,
    visible: currentResult?.status === "confirmed" && currentResult.visible,
    state: currentResult?.status === "confirmed" ? currentResult.state : null,
    authExpired: currentResult?.status === "reauthentication",
    clearAuthExpired,
  };
}
