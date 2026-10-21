"use client";

import { useEffect } from "react";

export type State =
  | "standby"
  | "not_started"
  | "opening"
  | "question"
  | "answer"
  | "podium_preview"
  | "third"
  | "second"
  | "first"
  | "finished";

export type PublicQuestion = {
  id: string | number;
  ordinal: number;
  total: number;
  question: string;
  choices: string[];
};
export type PublicAnswerQuestion = PublicQuestion & {
  correctAnswer?: string;
  correctIndex?: number;
  explanation?: string | null;
  answerType?: "selected" | "freeText";
  expectedAnswer?: string | null;
  responses?: {
    displayName: string;
    answer?: string | null;
    answerKind: "selected" | "freeText" | "legacy" | "unanswered";
    similarity: number | null;
    score: number | null;
  }[];
};

export type WinnerQuestionResult = {
  position: number;
  question: string | null;
  answer:
    | { kind: "selected"; value: string | null }
    | { kind: "freeText"; value: string | null }
    | { kind: "unanswered" }
    | { kind: "legacy" }
    | { kind: "unavailable" };
  correctness?: "correct" | "incorrect" | "unavailable";
  normalizedScore?: number | null;
  scoreStatus?: "unavailable";
};
export type Winner = {
  displayName: string;
  score: number;
  rank: number;
  questionResults?: WinnerQuestionResult[];
};
export type ProjectionData =
  | { state: "question"; question: PublicQuestion }
  | { state: "answer"; question: PublicAnswerQuestion }
  | { state: Exclude<State, "question" | "answer">; winners?: Winner[] };

const POLL_TIMEOUT_MS = 8_000;

async function getProjection(signal: AbortSignal): Promise<ProjectionData> {
  const response = await fetch("/api/presentation", {
    cache: "no-store",
    credentials: "omit",
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : "投影状態を取得できませんでした。";
    throw new Error(detail);
  }
  if (!isProjectionData(payload)) throw new Error("投影状態を取得できませんでした。");
  return payload;
}

export function isProjectionData(payload: unknown): payload is ProjectionData {
  if (typeof payload !== "object" || payload === null || !("state" in payload)) return false;
  const value = payload as Record<string, unknown>;
  if (
    typeof value.state !== "string" ||
    ![
      "standby",
      "not_started",
      "opening",
      "question",
      "answer",
      "podium_preview",
      "third",
      "second",
      "first",
      "finished",
    ].includes(value.state)
  )
    return false;
  if (value.state === "question" || value.state === "answer") {
    if (typeof value.question !== "object" || value.question === null) return false;
    const question = value.question as Record<string, unknown>;
    return (
      (typeof question.id === "string" || typeof question.id === "number") &&
      Number.isInteger(question.ordinal) &&
      Number.isInteger(question.total) &&
      typeof question.question === "string" &&
      Array.isArray(question.choices) &&
      question.choices.every((choice) => typeof choice === "string")
    );
  }
  if (["third", "second", "first"].includes(value.state) && value.winners !== undefined) {
    return (
      Array.isArray(value.winners) &&
      value.winners.every((winner) => {
        if (typeof winner !== "object" || winner === null) return false;
        const entry = winner as Record<string, unknown>;
        return (
          typeof entry.displayName === "string" &&
          typeof entry.score === "number" &&
          typeof entry.rank === "number"
        );
      })
    );
  }
  return true;
}

/** Owns the public projection poll and its timeout, abort, and timer cleanup. */
export function usePublicProjection(
  presenterRequested: boolean,
  applyProjection: (projection: ProjectionData) => void,
  setPollError: (error: boolean) => void,
) {
  useEffect(() => {
    if (presenterRequested) return;
    let active = true;
    let timer = 0;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (!active) return;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), POLL_TIMEOUT_MS);
      try {
        const next = await getProjection(controller.signal);
        if (active) {
          applyProjection(next);
          setPollError(false);
        }
      } catch {
        if (active) setPollError(true);
      } finally {
        window.clearTimeout(timeout);
        if (active) timer = window.setTimeout(refresh, 1400);
      }
    };
    void refresh();
    return () => {
      active = false;
      controller?.abort();
      window.clearTimeout(timer);
    };
  }, [applyProjection, presenterRequested, setPollError]);
}
