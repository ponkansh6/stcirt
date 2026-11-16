"use client";

import { useEffect } from "react";

export type State =
  | "standby"
  | "not_started"
  | "opening"
  | "question"
  | "answer"
  | "statistics"
  | "podium_preview"
  | "third"
  | "second"
  | "first"
  | "third_prize"
  | "second_prize"
  | "first_prize"
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
  correctIndices?: number[] | null;
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
export type PublicStatistics =
  | {
      kind: "selected";
      multiple: boolean | null;
      participantCount: number;
      validRespondentCount: number;
      uncountableCount: number;
      choices: { label: string; count: number }[];
    }
  | {
      kind: "freeText";
      participantCount: number;
      gradedCount: number;
      ungradedCount: number;
      uncountableCount: number;
      ranges: { label: string; count: number }[];
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
  | { state: "statistics"; question: PublicQuestion; statistics: PublicStatistics }
  | { state: Exclude<State, "question" | "answer" | "statistics">; winners?: Winner[] };

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
  if (isMissingQuestionPayload(payload)) {
    throw Object.assign(new Error("投影状態に問題データがありません。"), {
      missingQuestionPayload: true,
    });
  }
  if (!isProjectionData(payload)) throw new Error("投影状態を取得できませんでした。");
  return payload;
}

export function isMissingQuestionPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const value = payload as Record<string, unknown>;
  return (
    (value.state === "question" || value.state === "answer" || value.state === "statistics") &&
    (!("question" in value) || value.question === null)
  );
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
      "statistics",
      "podium_preview",
      "third",
      "second",
      "first",
      "third_prize",
      "second_prize",
      "first_prize",
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
  if (value.state === "statistics") {
    if (
      typeof value.question !== "object" ||
      value.question === null ||
      typeof value.statistics !== "object" ||
      value.statistics === null
    )
      return false;
    const question = value.question as Record<string, unknown>;
    const stats = value.statistics as Record<string, unknown>;
    if (
      !(
        (typeof question.id === "number" || typeof question.id === "string") &&
        Number.isInteger(question.ordinal) &&
        Number.isInteger(question.total) &&
        typeof question.question === "string" &&
        Array.isArray(question.choices) &&
        question.choices.every((choice) => typeof choice === "string")
      )
    )
      return false;
    if (!Number.isInteger(stats.participantCount) || (stats.participantCount as number) < 0)
      return false;
    const summaryKeys =
      stats.kind === "selected"
        ? ["validRespondentCount", "uncountableCount"]
        : stats.kind === "freeText"
          ? ["gradedCount", "ungradedCount", "uncountableCount"]
          : [];
    if (
      summaryKeys.length === 0 ||
      summaryKeys.some((key) => !Number.isInteger(stats[key]) || (stats[key] as number) < 0)
    )
      return false;
    if (stats.kind === "selected" && stats.multiple !== null && typeof stats.multiple !== "boolean")
      return false;
    const counts = stats.kind === "selected" ? stats.choices : stats.ranges;
    return (
      Array.isArray(counts) &&
      counts.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>).label === "string" &&
          Number.isInteger((item as Record<string, unknown>).count) &&
          ((item as Record<string, unknown>).count as number) >= 0,
      )
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
  applyProjection: (projection: ProjectionData | null) => void,
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
      } catch (error) {
        if (active) {
          if ((error as { missingQuestionPayload?: boolean })?.missingQuestionPayload) {
            applyProjection(null);
            setPollError(false);
          } else {
            setPollError(true);
          }
        }
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
