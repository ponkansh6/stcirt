"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AnswerCompletionSnapshot,
  AnswerBootstrap,
  AnswerScope,
  AnswerSubmission,
  AssistedParticipantState,
  Participant,
} from "@/lib/api/client";
import {
  ApiError,
  createAssistedParticipant,
  createParticipantSession,
  deleteParticipantSession,
  fetchAssistedParticipant,
  fetchAnswerSubmission,
  fetchAnswerBootstrap,
  fetchLatestAnswerSubmission,
  fetchExamQuestions,
  fetchParticipantSession,
  submitAnswerBatch,
} from "@/lib/api/client";
import type { QuizQuestion } from "@/types/quiz";
import { shuffleChoices } from "@/lib/shuffle";
import { EXAM_QUESTION_COUNT, QUIZ_CHOICES_PER_QUESTION } from "@/lib/constants";
import {
  clearAssistedDraft,
  readAssistedDraft,
  writeAssistedDraft,
  type AssistedDraft,
  type LoadedQuiz,
} from "./assisted-draft";

export type { LoadedQuiz } from "./assisted-draft";

export type Phase =
  | { kind: "ready" }
  | { kind: "checking-submission" }
  | { kind: "submission-error"; message: string }
  | { kind: "owner-return-error"; message: string }
  | { kind: "loading" }
  | { kind: "shortage" }
  | { kind: "load-error"; message: string }
  | {
      kind: "answering";
      message?: string;
      retryRequired?: boolean;
      refreshRequired?: boolean;
      publishedLock?: boolean;
    }
  | { kind: "submitting" }
  | { kind: "refreshing" }
  | { kind: "complete"; completionSnapshot?: AnswerCompletionSnapshot };

function completedPhase(
  completionSnapshot: AnswerCompletionSnapshot | null | undefined,
): Extract<Phase, { kind: "complete" }> {
  return completionSnapshot?.status === "ready"
    ? { kind: "complete", completionSnapshot }
    : { kind: "complete" };
}

export type AccessState =
  | { kind: "checking" }
  | { kind: "login"; message?: string }
  | { kind: "ready"; participant: Participant }
  | { kind: "switching"; participant: Participant }
  | { kind: "reauthentication"; participant: Participant };

export function requireParticipantReauthentication(
  current: AccessState,
  requestOwnerId: number,
): AccessState {
  if (current.kind !== "ready" || current.participant.id !== requestOwnerId) return current;
  return { kind: "reauthentication", participant: current.participant };
}

export type AnswerMode = AnswerScope;
export type AssistedScreen = "closed" | "login" | "active";

const ASSISTED_MODE_KEY = "stcirt-answer-scope";

type BatchAnswer =
  | { questionId: number; selectedIndex: number }
  | { questionId: number; freeText: string };
type SaveAttempt = {
  operationId: string;
  expectedRevision: number;
  answers: BatchAnswer[];
  selectedByQuestion: Record<number, number>;
  freeResponses: Record<number, string>;
};
type SelectedAnswer = AnswerSubmission["answers"][number] & {
  answerKind: "selected";
  selectedIndex: number;
};

function hasCompleteRestoreIntegrity(submission: AnswerSubmission): boolean {
  const integrity = submission.restoreIntegrity;
  if (
    integrity?.status !== "complete" ||
    integrity.questions.length !== EXAM_QUESTION_COUNT ||
    submission.answers.length !== EXAM_QUESTION_COUNT
  ) {
    return false;
  }
  const questions = integrity.questions;
  const questionIds = questions.map(({ id }) => id);
  const answerIds = submission.answers.map(({ questionId }) => questionId);
  if (
    new Set(questionIds).size !== EXAM_QUESTION_COUNT ||
    new Set(answerIds).size !== EXAM_QUESTION_COUNT ||
    questions.some(({ id }, index) => index > 0 && id <= questions[index - 1]!.id) ||
    questions.some(({ answerType, choiceCount }) =>
      answerType === "freeText"
        ? choiceCount !== 0
        : choiceCount < 2 || choiceCount > QUIZ_CHOICES_PER_QUESTION,
    ) ||
    answerIds.some((id) => !questionIds.includes(id))
  ) {
    return false;
  }

  // Both five-item ID sets are unique, equal in size, and answerIds is a
  // subset of questionIds, so every question has exactly one matching answer.
  return questions.every(({ id, answerType }, index) => {
    const answer = submission.answers.find(({ questionId }) => questionId === id)!;
    if (answerType === "selected") {
      return (
        answer.answerKind === "selected" &&
        Number.isInteger(answer.selectedIndex) &&
        answer.selectedIndex! >= 0 &&
        answer.selectedIndex! < questions[index]!.choiceCount &&
        answer.freeText === null
      );
    }
    if (answer.answerKind === "legacy") {
      return (
        index === EXAM_QUESTION_COUNT - 1 &&
        Number.isInteger(answer.selectedIndex) &&
        answer.selectedIndex! >= 0 &&
        answer.selectedIndex! < QUIZ_CHOICES_PER_QUESTION &&
        answer.freeText === null
      );
    }
    return (
      answer.answerKind === "freeText" &&
      answer.selectedIndex === null &&
      Boolean(answer.freeText?.trim()) &&
      answer.freeText!.trim().length <= 1000
    );
  });
}

class InvalidSavedSubmissionError extends Error {
  constructor() {
    super("保存済み回答と現在の設問が一致しないため、回答を復元できません。");
    this.name = "InvalidSavedSubmissionError";
  }
}

function newId() {
  return globalThis.crypto.randomUUID();
}

function copySelections(selections: Record<number, number | undefined>) {
  return { ...selections };
}

function copyAnsweredSelections(
  selections: Record<number, number | undefined>,
): Record<number, number> {
  return Object.fromEntries(
    Object.entries(selections).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}

function restoreDisplaySelections(
  answers: SelectedAnswer[],
  quizzes: LoadedQuiz[],
): Record<number, number> {
  const restored: Record<number, number> = {};
  for (const answer of answers) {
    const quiz = quizzes.find(({ question }) => question.id === answer.questionId)!;
    const displayIndex = quiz.shuffled.choiceIndices.indexOf(answer.selectedIndex);
    if (displayIndex < 0) throw new Error("保存済み回答を問題に対応づけられませんでした。");
    restored[answer.questionId] = displayIndex;
  }
  return restored;
}

function restoreSavedAnswers(
  submission: AnswerSubmission,
  quizzes: LoadedQuiz[],
  expectedSubmissionId?: string,
): {
  selections: Record<number, number>;
  freeResponses: Record<number, string>;
  legacyAnswerIds: number[];
} {
  try {
    if (
      (expectedSubmissionId !== undefined && submission.submissionId !== expectedSubmissionId) ||
      submission.answers.length !== EXAM_QUESTION_COUNT ||
      quizzes.length !== EXAM_QUESTION_COUNT
    ) {
      throw new Error("submission identity or shape mismatch");
    }
    const answerQuestionIds = new Set(submission.answers.map(({ questionId }) => questionId));
    const quizQuestionIds = new Set(quizzes.map(({ question }) => question.id));
    if (
      answerQuestionIds.size !== submission.answers.length ||
      answerQuestionIds.size !== quizQuestionIds.size ||
      [...answerQuestionIds].some((questionId) => !quizQuestionIds.has(questionId))
    ) {
      throw new Error("question set mismatch");
    }

    for (const { question } of quizzes) {
      // The validated answer IDs form a duplicate-free subset of the quiz IDs
      // with the same cardinality, so every quiz has exactly one matching answer.
      const answer = submission.answers.find((candidate) => candidate.questionId === question.id)!;
      if (question.answerType === "freeText") {
        if (answer.answerKind === "legacy") {
          if (answer.selectedIndex === null || answer.freeText !== null) {
            throw new Error("invalid legacy answer");
          }
          continue;
        }
        if (
          answer.answerKind !== "freeText" ||
          !answer.freeText?.trim() ||
          answer.freeText.trim().length > 1000 ||
          answer.selectedIndex !== null
        ) {
          throw new Error("invalid free text answer");
        }
      } else if (
        answer.answerKind !== "selected" ||
        answer.selectedIndex === null ||
        answer.freeText !== null
      ) {
        throw new Error("invalid selected answer");
      }
    }

    const selectedAnswers = submission.answers.filter(
      (answer): answer is SelectedAnswer =>
        answer.answerKind === "selected" && answer.selectedIndex !== null,
    );
    const selections = restoreDisplaySelections(selectedAnswers, quizzes);
    return {
      selections,
      freeResponses: Object.fromEntries(
        submission.answers.flatMap((answer) =>
          answer.answerKind === "freeText" && answer.freeText
            ? [[answer.questionId, answer.freeText]]
            : [],
        ),
      ),
      legacyAnswerIds: submission.answers
        .filter((answer) => answer.answerKind === "legacy")
        .map((answer) => answer.questionId),
    };
  } catch {
    throw new InvalidSavedSubmissionError();
  }
}

export function useQuizSession() {
  const [answerMode, setAnswerMode] = useState<AnswerMode>("owner");
  const [assistedScreen, setAssistedScreen] = useState<AssistedScreen>("closed");
  const [assistedParticipant, setAssistedParticipant] = useState<AssistedParticipantState | null>(
    null,
  );
  const [assistedError, setAssistedError] = useState<string | null>(null);
  const [assistedBusy, setAssistedBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });
  const [access, setAccess] = useState<AccessState>({ kind: "checking" });
  const [quizzes, setQuizzes] = useState<LoadedQuiz[]>([]);
  const [selections, setSelections] = useState<Record<number, number | undefined>>({});
  const [freeResponses, setFreeResponses] = useState<Record<number, string>>({});
  const [legacyAnswerIds, setLegacyAnswerIds] = useState<number[]>([]);
  const legacyAnswerIdsRef = useRef(legacyAnswerIds);
  const [savedSelections, setSavedSelections] = useState<Record<number, number | undefined>>({});
  const [answeredCount, setAnsweredCount] = useState(0);
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [saveConfirmed, setSaveConfirmed] = useState(false);
  const [isPreparingEdit, setIsPreparingEdit] = useState(false);
  const [editLoadError, setEditLoadError] = useState<string | null>(null);
  const [autoEditAssisted, setAutoEditAssisted] = useState(false);
  const savedSubmissionRef = useRef<AnswerSubmission | null>(null);
  const editingRef = useRef(false);
  const editGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const sessionEpochRef = useRef(0);
  const busyRef = useRef(false);
  const busyEpochRef = useRef<number | null>(null);
  const checkingSubmissionRef = useRef(false);
  const quizzesRef = useRef(quizzes);
  const phaseRef = useRef(phase);
  const accessRef = useRef(access);
  const selectionsRef = useRef(selections);
  const freeResponsesRef = useRef(freeResponses);
  const submissionIdRef = useRef(submissionId);
  const revisionRef = useRef(revision);
  const failedAttemptRef = useRef<SaveAttempt | null>(null);
  const preserveDraftOnSavedRefreshRef = useRef(false);
  const reloadedAssistedRef = useRef(false);
  const returnToOwnerRef = useRef<((afterSave?: boolean) => void) | null>(null);
  const ownerReturnAfterAssistedSaveRef = useRef(false);
  const assistedRequestRef = useRef(false);
  const assistedParticipantIdRef = useRef<number | null>(null);
  const answerModeRef = useRef<AnswerMode>("owner");
  assistedParticipantIdRef.current = assistedParticipant?.participant?.id ?? null;
  answerModeRef.current = answerMode;
  phaseRef.current = phase;
  accessRef.current = access;
  quizzesRef.current = quizzes;
  selectionsRef.current = selections;
  freeResponsesRef.current = freeResponses;
  submissionIdRef.current = submissionId;
  revisionRef.current = revision;
  legacyAnswerIdsRef.current = legacyAnswerIds;

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      sessionEpochRef.current += 1;
      busyRef.current = false;
      busyEpochRef.current = null;
      const sessionEpoch = sessionEpochRef.current;
      let initialMode: AnswerMode =
        window.sessionStorage.getItem(ASSISTED_MODE_KEY) === "assisted" ? "assisted" : "owner";
      answerModeRef.current = initialMode;
      setAnswerMode(initialMode);
      setPhase({ kind: "checking-submission" });
      try {
        let bootstrap: AnswerBootstrap;
        try {
          bootstrap = await fetchAnswerBootstrap(initialMode);
        } catch (error) {
          // A stale assisted scope can outlive a deleted/unlinked target. Preserve
          // the previous fallback to the authenticated owner session, but do not
          // treat any transport or server error as a new attempt.
          if (initialMode !== "assisted" || !(error instanceof ApiError) || error.status !== 404) {
            throw error;
          }
          initialMode = "owner";
          answerModeRef.current = "owner";
          window.sessionStorage.removeItem(ASSISTED_MODE_KEY);
          clearAssistedDraft();
          bootstrap = await fetchAnswerBootstrap("owner");
        }
        if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;

        // A saved assisted submission without a matching persisted edit draft
        // cannot be restored as an in-progress answer sheet. Fall back to the
        // owner's completion view through the same bootstrap contract rather
        // than starting a legacy latest-submission request from the access
        // effect below.
        if (initialMode === "assisted" && bootstrap.submission !== null) {
          const assistedDraft = readAssistedDraft(bootstrap.participant.id);
          const draftMatchesSubmission = Boolean(
            assistedDraft &&
            assistedDraft.submissionId === bootstrap.submission.submissionId &&
            assistedDraft.revision === bootstrap.submission.revision,
          );
          if (!draftMatchesSubmission) {
            initialMode = "owner";
            answerModeRef.current = "owner";
            window.sessionStorage.removeItem(ASSISTED_MODE_KEY);
            clearAssistedDraft();
            bootstrap = await fetchAnswerBootstrap("owner");
            if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;
          }
        }

        const owner = bootstrap.owner;
        const participant = bootstrap.participant;
        const submission = bootstrap.submission;
        const draft = initialMode === "assisted" ? readAssistedDraft(participant.id) : null;
        const loadedFromQuestions = (questions: QuizQuestion[]): LoadedQuiz[] =>
          questions.map((question) => ({
            question,
            shuffled: shuffleChoices(question.choices),
          }));

        const restoreDraft = (assistedDraft: AssistedDraft) => {
          reloadedAssistedRef.current = false;
          quizzesRef.current = assistedDraft.quizzes;
          setQuizzes(assistedDraft.quizzes);
          submissionIdRef.current = assistedDraft.submissionId;
          setSubmissionId(assistedDraft.submissionId);
          revisionRef.current = assistedDraft.revision;
          setRevision(assistedDraft.revision);
          selectionsRef.current = assistedDraft.selections;
          setSelections(assistedDraft.selections);
          setSavedSelections({});
          freeResponsesRef.current = assistedDraft.freeResponses;
          setFreeResponses(assistedDraft.freeResponses);
          legacyAnswerIdsRef.current = assistedDraft.legacyAnswerIds;
          setLegacyAnswerIds(assistedDraft.legacyAnswerIds);
          setAnsweredCount(
            Object.keys(assistedDraft.selections).length +
              Object.values(assistedDraft.freeResponses).filter((value) => value.trim()).length,
          );
          setPhase({ kind: "answering" });
        };

        reloadedAssistedRef.current = initialMode === "assisted";
        answerModeRef.current = initialMode;
        setAnswerMode(initialMode);
        setAssistedScreen(initialMode === "assisted" ? "active" : "closed");
        setAssistedParticipant(
          initialMode === "assisted"
            ? { participant, hasSubmission: submission !== null, eligible: false }
            : null,
        );
        setAccess({ kind: "ready", participant: owner });
        assistedParticipantIdRef.current = initialMode === "assisted" ? participant.id : null;
        setSaveConfirmed(false);
        setRestoreError(null);

        if (initialMode === "owner") window.sessionStorage.removeItem(ASSISTED_MODE_KEY);

        if (submission === null) {
          reloadedAssistedRef.current = false;
          savedSubmissionRef.current = null;
          setSubmissionId(null);
          submissionIdRef.current = null;
          setRevision(0);
          revisionRef.current = 0;
          setSavedSelections({});
          selectionsRef.current = {};
          setSelections({});
          freeResponsesRef.current = {};
          setFreeResponses({});
          legacyAnswerIdsRef.current = [];
          setLegacyAnswerIds([]);
          setAnsweredCount(0);

          if (draft) {
            restoreDraft(draft);
            return;
          }

          const loaded = loadedFromQuestions(bootstrap.questions!);
          const id = newId();
          quizzesRef.current = loaded;
          setQuizzes(loaded);
          submissionIdRef.current = id;
          setSubmissionId(id);
          setPhase({ kind: "answering" });
          return;
        }

        savedSubmissionRef.current = submission;
        submissionIdRef.current = submission.submissionId;
        setSubmissionId(submission.submissionId);
        revisionRef.current = submission.revision;
        setRevision(submission.revision);

        if (
          initialMode === "assisted" &&
          draft &&
          draft.submissionId === submission.submissionId &&
          draft.revision === submission.revision
        ) {
          if (!hasCompleteRestoreIntegrity(submission)) {
            setRestoreError(
              "保存済み回答の整合性を確認できません。確認のため再読み込みしてください。",
            );
            setSaveConfirmed(false);
            setAnsweredCount(0);
            setPhase({ kind: "complete" });
            return;
          }
          restoreDraft(draft);
          return;
        }

        if (!hasCompleteRestoreIntegrity(submission)) {
          setRestoreError(
            "保存済み回答の整合性を確認できません。確認のため再読み込みしてください。",
          );
          setSaveConfirmed(false);
          setAnsweredCount(0);
          setPhase({ kind: "complete" });
          return;
        }

        setSelections({});
        selectionsRef.current = {};
        setFreeResponses({});
        freeResponsesRef.current = {};
        setLegacyAnswerIds([]);
        legacyAnswerIdsRef.current = [];
        setSavedSelections({});
        setAnsweredCount(0);
        setSaveConfirmed(true);
        setPhase(
          bootstrap.completionSnapshot?.status === "ready"
            ? { kind: "complete", completionSnapshot: bootstrap.completionSnapshot }
            : { kind: "complete" },
        );
      } catch (error) {
        if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;
        if (error instanceof ApiError && error.status === 401) {
          let owner: Participant | null = null;
          let participantLookupFailed = false;
          let participantLookupError: unknown;
          try {
            owner = await fetchParticipantSession();
          } catch (lookupError) {
            participantLookupFailed = true;
            participantLookupError = lookupError;
          }
          if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;
          if (!owner) {
            const authRejected =
              participantLookupError instanceof ApiError &&
              (participantLookupError.status === 401 || participantLookupError.status === 403);
            if (participantLookupFailed && !authRejected) {
              setAccess({
                kind: "login",
                message:
                  "参加状態を確認できませんでした。通信状態を確認してから再読み込みしてください。",
              });
              return;
            }
            window.sessionStorage.removeItem(ASSISTED_MODE_KEY);
            clearAssistedDraft();
            answerModeRef.current = "owner";
            setAnswerMode("owner");
            setAssistedScreen("closed");
            setAssistedParticipant(null);
            assistedParticipantIdRef.current = null;
            setAccess(
              authRejected
                ? {
                    kind: "login",
                    message: "参加状態を確認できませんでした。お名前とPINを入力してください。",
                  }
                : { kind: "login" },
            );
            return;
          }

          clearAssistedDraft();
          let assisted: AssistedParticipantState | null = null;
          if (initialMode === "assisted") {
            try {
              assisted = await fetchAssistedParticipant();
            } catch {
              // Keep the assisted scope for reauthentication; it is resolved again
              // when the participant resumes the session.
            }
          }
          if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;
          answerModeRef.current = initialMode;
          setAnswerMode(initialMode);
          setAssistedScreen(initialMode === "assisted" ? "active" : "closed");
          setAssistedParticipant(assisted);
          assistedParticipantIdRef.current = assisted?.participant?.id ?? null;
          reloadedAssistedRef.current = initialMode === "assisted";
          setPhase({ kind: "ready" });
          setAccess({ kind: "reauthentication", participant: owner });
          return;
        }

        // Preserve a retryable error (and any assisted draft) for scope and
        // server failures. Fetch identity only on this error path so the UI can
        // keep its existing retry action without interpreting failure as null.
        try {
          const owner = await fetchParticipantSession();
          if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;
          if (!owner) {
            window.sessionStorage.removeItem(ASSISTED_MODE_KEY);
            clearAssistedDraft();
            answerModeRef.current = "owner";
            setAnswerMode("owner");
            setAssistedScreen("closed");
            setAssistedParticipant(null);
            assistedParticipantIdRef.current = null;
            setAccess({ kind: "login" });
            return;
          }

          let assisted: AssistedParticipantState | null = null;
          if (initialMode === "assisted") {
            try {
              assisted = await fetchAssistedParticipant();
            } catch {
              // Keep the assisted mode and its draft. The retry action can
              // re-check the latest scoped submission without creating a new one.
            }
          }
          if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;

          answerModeRef.current = initialMode;
          setAnswerMode(initialMode);
          reloadedAssistedRef.current = initialMode === "assisted";
          setAssistedScreen(initialMode === "assisted" ? "active" : "closed");
          setAssistedParticipant(assisted);
          assistedParticipantIdRef.current = assisted?.participant?.id ?? null;
          setAccess({ kind: "ready", participant: owner });
          setPhase({
            kind: "submission-error",
            message: "回答状況を確認できませんでした。通信状態を確認して再試行してください。",
          });
        } catch {
          if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;
          setAccess({
            kind: "login",
            message:
              "参加状態を確認できませんでした。通信状態を確認してから再読み込みしてください。",
          });
        }
      }
    })();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadQuestions = useCallback(async (restart = false): Promise<LoadedQuiz[] | null> => {
    if (busyRef.current) return null;
    const sessionEpoch = sessionEpochRef.current;
    busyRef.current = true;
    busyEpochRef.current = sessionEpoch;
    if (restart) {
      preserveDraftOnSavedRefreshRef.current = false;
      quizzesRef.current = [];
      setQuizzes([]);
      setSelections({});
      setFreeResponses({});
      freeResponsesRef.current = {};
      setLegacyAnswerIds([]);
      legacyAnswerIdsRef.current = [];
      selectionsRef.current = {};
      setSavedSelections({});
      setAnsweredCount(0);
      const id = newId();
      submissionIdRef.current = id;
      setSubmissionId(id);
      revisionRef.current = 0;
      setRevision(0);
      failedAttemptRef.current = null;
    }
    setPhase({ kind: "loading" });
    try {
      const questions = await fetchExamQuestions();
      if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return null;
      if (
        questions.length !== EXAM_QUESTION_COUNT ||
        new Set(questions.map(({ id }) => id)).size !== EXAM_QUESTION_COUNT ||
        questions.some(({ id }, index) => index > 0 && id <= questions[index - 1]!.id)
      ) {
        throw new Error("Invalid exam question batch");
      }
      const loaded = questions.map((question) => ({
        question,
        shuffled: shuffleChoices(question.choices),
      }));
      quizzesRef.current = loaded;
      setQuizzes(loaded);
      setPhase({ kind: "answering" });
      return loaded;
    } catch {
      if (mountedRef.current && sessionEpoch === sessionEpochRef.current) {
        setPhase({
          kind: "load-error",
          message: "問題を読み込めませんでした。通信状態を確認して、もう一度お試しください。",
        });
      }
      return null;
    } finally {
      if (busyEpochRef.current === sessionEpoch) {
        busyRef.current = false;
        busyEpochRef.current = null;
      }
    }
  }, []);

  const resolveParticipant = useCallback(
    async (
      participant: Participant,
      scope: AnswerScope = answerModeRef.current,
      editAssistedSubmission = false,
      assistedParticipantId?: number,
      useBootstrap = false,
    ) => {
      if (busyRef.current || checkingSubmissionRef.current) return;
      const sessionEpoch = sessionEpochRef.current;
      preserveDraftOnSavedRefreshRef.current = false;
      checkingSubmissionRef.current = true;
      const draftParticipantId =
        assistedParticipantId ?? assistedParticipantIdRef.current ?? undefined;
      setAccess({ kind: "ready", participant });
      setPhase({ kind: "checking-submission" });
      let returnOwnerAfterReload = false;
      try {
        let latest: AnswerSubmission | null;
        let completionSnapshot: AnswerCompletionSnapshot | undefined;
        let bootstrapQuestions: AnswerBootstrap["questions"] | undefined = undefined;
        if (useBootstrap) {
          const bootstrap = await fetchAnswerBootstrap(scope);
          latest = bootstrap.submission;
          completionSnapshot =
            bootstrap.completionSnapshot?.status === "ready"
              ? bootstrap.completionSnapshot
              : undefined;
          bootstrapQuestions = bootstrap.questions;
        } else {
          latest = await fetchLatestAnswerSubmission(scope);
        }
        if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;
        if (!latest) {
          savedSubmissionRef.current = null;
          setAutoEditAssisted(false);
          preserveDraftOnSavedRefreshRef.current = false;
          if (scope === "owner" && ownerReturnAfterAssistedSaveRef.current) {
            setPhase({
              kind: "owner-return-error",
              message: "代理回答は保存されましたが、自分の保存済み回答を確認できませんでした。",
            });
            return;
          }
          if (scope === "owner") ownerReturnAfterAssistedSaveRef.current = false;
          setRestoreError(null);
          if (scope === "assisted") {
            const draft =
              scope === "assisted" && draftParticipantId
                ? readAssistedDraft(draftParticipantId)
                : /* v8 ignore next */ null; // Assisted mode requires its linked participant.
            if (draft) {
              reloadedAssistedRef.current = false;
              quizzesRef.current = draft.quizzes;
              setQuizzes(draft.quizzes);
              submissionIdRef.current = draft.submissionId;
              setSubmissionId(draft.submissionId);
              revisionRef.current = draft.revision;
              setRevision(draft.revision);
              selectionsRef.current = draft.selections;
              setSelections(draft.selections);
              setSavedSelections({});
              freeResponsesRef.current = draft.freeResponses;
              setFreeResponses(draft.freeResponses);
              setLegacyAnswerIds(draft.legacyAnswerIds);
              const count =
                Object.keys(draft.selections).length +
                Object.values(draft.freeResponses).filter((value) => value.trim()).length;
              setAnsweredCount(count);
              setPhase({ kind: "answering" });
              return;
            }
            reloadedAssistedRef.current = false;
          }
          if (bootstrapQuestions) {
            const loaded = bootstrapQuestions.map((question) => ({
              question,
              shuffled: shuffleChoices(question.choices),
            }));
            const id = newId();
            quizzesRef.current = loaded;
            setQuizzes(loaded);
            submissionIdRef.current = id;
            setSubmissionId(id);
            setPhase({ kind: "answering" });
          } else {
            await loadQuestions(true);
          }
          return;
        }
        savedSubmissionRef.current = latest;

        if (scope === "assisted") {
          const draft =
            scope === "assisted" && draftParticipantId
              ? readAssistedDraft(draftParticipantId)
              : /* v8 ignore next */ null; // Assisted mode requires its linked participant.
          if (
            draft &&
            draft.submissionId === latest.submissionId &&
            draft.revision === latest.revision
          ) {
            if (!hasCompleteRestoreIntegrity(latest)) {
              setRestoreError(
                "保存済み回答の整合性を確認できません。確認のため再読み込みしてください。",
              );
              setSaveConfirmed(false);
              setSavedSelections({});
              selectionsRef.current = {};
              freeResponsesRef.current = {};
              legacyAnswerIdsRef.current = [];
              setSelections({});
              setFreeResponses({});
              setLegacyAnswerIds([]);
              setAnsweredCount(0);
              setAutoEditAssisted(false);
              setPhase({ kind: "complete" });
              return;
            }
            reloadedAssistedRef.current = false;
            quizzesRef.current = draft.quizzes;
            setQuizzes(draft.quizzes);
            submissionIdRef.current = draft.submissionId;
            setSubmissionId(draft.submissionId);
            revisionRef.current = draft.revision;
            setRevision(draft.revision);
            selectionsRef.current = draft.selections;
            setSelections(draft.selections);
            freeResponsesRef.current = draft.freeResponses;
            setFreeResponses(draft.freeResponses);
            setLegacyAnswerIds(draft.legacyAnswerIds);
            setSavedSelections({});
            setAnsweredCount(
              Object.keys(draft.selections).length +
                Object.values(draft.freeResponses).filter((value) => value.trim()).length,
            );
            setRestoreError(null);
            setPhase({ kind: "answering" });
            return;
          }
        }

        if (scope === "assisted" && reloadedAssistedRef.current) {
          reloadedAssistedRef.current = false;
          clearAssistedDraft();
          returnOwnerAfterReload = true;
          return;
        }

        submissionIdRef.current = latest.submissionId;
        setSubmissionId(latest.submissionId);
        revisionRef.current = latest.revision;
        setRevision(latest.revision);
        failedAttemptRef.current = null;

        if (!hasCompleteRestoreIntegrity(latest)) {
          if (scope === "owner" && ownerReturnAfterAssistedSaveRef.current) {
            setPhase({
              kind: "owner-return-error",
              message: "代理回答は保存されましたが、自分の保存済み回答を確認できませんでした。",
            });
            return;
          }
          setRestoreError(
            "保存済み回答の整合性を確認できません。確認のため再読み込みしてください。",
          );
          setSaveConfirmed(false);
          setSavedSelections({});
          selectionsRef.current = {};
          freeResponsesRef.current = {};
          legacyAnswerIdsRef.current = [];
          setSelections({});
          setFreeResponses({});
          setLegacyAnswerIds([]);
          setAnsweredCount(0);
          setAutoEditAssisted(false);
          setPhase({ kind: "complete" });
          return;
        }

        setRestoreError(null);
        setSavedSelections({});
        selectionsRef.current = {};
        freeResponsesRef.current = {};
        legacyAnswerIdsRef.current = [];
        setSelections({});
        setFreeResponses({});
        setLegacyAnswerIds([]);
        setAnsweredCount(0);
        setSaveConfirmed(true);
        if (scope === "assisted" && editAssistedSubmission) {
          setAutoEditAssisted(true);
        }
        if (scope === "owner") ownerReturnAfterAssistedSaveRef.current = false;
        setPhase(
          completionSnapshot ? { kind: "complete", completionSnapshot } : { kind: "complete" },
        );
        return;
      } catch (error) {
        if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          clearAssistedDraft();
        }
        const unauthorized = error instanceof ApiError && error.status === 401;
        if (unauthorized) {
          setAccess({ kind: "reauthentication", participant });
        }
        if (ownerReturnAfterAssistedSaveRef.current) {
          setPhase({
            kind: "owner-return-error",
            message: "代理回答は保存されましたが、自分の回答状況を再読み込みできませんでした。",
          });
        } else if (unauthorized) {
          setPhase({ kind: "ready" });
        } else {
          setPhase({
            kind: "submission-error",
            message: "回答状況を確認できませんでした。通信状態を確認して再試行してください。",
          });
        }
      } finally {
        checkingSubmissionRef.current = false;
        if (returnOwnerAfterReload) returnToOwnerRef.current?.();
      }
    },
    [loadQuestions],
  );

  useEffect(() => {
    if (answerMode !== "owner" || phase.kind !== "complete" || access.kind !== "ready") return;
    const requestOwnerId = access.participant.id;
    let active = true;
    setAssistedBusy(true);
    void fetchAssistedParticipant()
      .then((result) => {
        if (!active) return;
        setAssistedParticipant(result);
        setAssistedError(null);
      })
      .catch((error) => {
        if (!active) return;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          clearAssistedDraft();
        }
        setAssistedError(
          error instanceof ApiError && error.status === 401
            ? "参加者セッションの有効期限が切れました。再ログインしてください。"
            : "代理回答の状態を確認できませんでした。時間をおいて再読み込みしてください。",
        );
        if (error instanceof ApiError && error.status === 401) {
          setAccess((current) => requireParticipantReauthentication(current, requestOwnerId));
        }
      })
      .finally(() => {
        if (active) setAssistedBusy(false);
      });
    return () => {
      active = false;
    };
  }, [access, answerMode, phase.kind]);

  const retrySubmissionCheck = useCallback(() => {
    const current = accessRef.current;
    if (current.kind !== "ready" || checkingSubmissionRef.current || busyRef.current) return;
    void resolveParticipant(current.participant);
  }, [resolveParticipant]);

  const persistAssistedDraft = useCallback(
    (selections = selectionsRef.current, freeResponses = freeResponsesRef.current) => {
      if (answerModeRef.current !== "assisted" || quizzesRef.current.length !== EXAM_QUESTION_COUNT)
        return;
      const participantId = assistedParticipantIdRef.current;
      const currentSubmissionId = submissionIdRef.current;
      /* v8 ignore if -- Five editable assisted questions are reached only after both IDs are initialized. */
      if (participantId === null || currentSubmissionId === null) return;
      writeAssistedDraft({
        participantId,
        quizzes: quizzesRef.current,
        selections: copyAnsweredSelections(selections),
        freeResponses,
        legacyAnswerIds: legacyAnswerIdsRef.current,
        submissionId: currentSubmissionId,
        revision: revisionRef.current,
      });
    },
    [],
  );

  const openAssistedLogin = useCallback(() => {
    if (answerModeRef.current !== "owner" || phaseRef.current.kind !== "complete") return;
    setAssistedError(null);
    setAssistedScreen("login");
  }, []);

  const activateAssisted = useCallback(
    async (
      participant: Participant,
      hasSubmission: boolean,
      eligible = true,
      editAssistedSubmission = false,
    ) => {
      const current = accessRef.current;
      if (current.kind !== "ready" || busyRef.current || checkingSubmissionRef.current) return;
      sessionEpochRef.current += 1;
      busyRef.current = false;
      busyEpochRef.current = null;
      editGenerationRef.current += 1;
      editingRef.current = false;
      setIsPreparingEdit(false);
      setEditLoadError(null);
      savedSubmissionRef.current = null;
      preserveDraftOnSavedRefreshRef.current = false;
      answerModeRef.current = "assisted";
      setAnswerMode("assisted");
      setSaveConfirmed(false);
      setAssistedScreen("active");
      setAssistedParticipant({ participant, hasSubmission, eligible });
      assistedParticipantIdRef.current = participant.id;
      setAssistedError(null);
      window.sessionStorage.setItem(ASSISTED_MODE_KEY, "assisted");
      quizzesRef.current = [];
      setQuizzes([]);
      selectionsRef.current = {};
      setSelections({});
      freeResponsesRef.current = {};
      setFreeResponses({});
      setLegacyAnswerIds([]);
      legacyAnswerIdsRef.current = [];
      setSavedSelections({});
      setAnsweredCount(0);
      submissionIdRef.current = null;
      setSubmissionId(null);
      revisionRef.current = 0;
      setRevision(0);
      failedAttemptRef.current = null;
      setRestoreError(null);
      await resolveParticipant(
        current.participant,
        "assisted",
        editAssistedSubmission,
        participant.id,
        true,
      );
    },
    [resolveParticipant],
  );

  const startAssisted = useCallback(
    async (name: string) => {
      if (assistedRequestRef.current || assistedBusy)
        throw new Error("処理中です。しばらくお待ちください。");
      assistedRequestRef.current = true;
      setAssistedBusy(true);
      setAssistedError(null);
      try {
        const result = await createAssistedParticipant(name);
        if (!mountedRef.current) return;
        await activateAssisted(result.participant, result.hasSubmission);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          clearAssistedDraft();
        }
        if (mountedRef.current) {
          if (error instanceof ApiError && error.status === 401) {
            const current = accessRef.current;
            if (current.kind === "ready") {
              setAccess({ kind: "reauthentication", participant: current.participant });
            }
          }
          setAssistedError(
            error instanceof Error ? error.message : "代理回答を開始できませんでした。",
          );
        }
        throw error;
      } finally {
        assistedRequestRef.current = false;
        if (mountedRef.current) setAssistedBusy(false);
      }
    },
    [activateAssisted, assistedBusy],
  );

  const resumeAssisted = useCallback(async () => {
    const state = assistedParticipant;
    if (!state?.participant) return;
    await activateAssisted(state.participant, state.hasSubmission, state.eligible, true);
  }, [activateAssisted, assistedParticipant]);

  const returnToOwner = useCallback(
    (afterSave = false) => {
      if (assistedRequestRef.current) return;
      const current = accessRef.current;
      if (answerModeRef.current !== "assisted") {
        setAssistedScreen("closed");
        setAssistedError(null);
        return;
      }
      if (current.kind !== "ready") return;
      ownerReturnAfterAssistedSaveRef.current = afterSave;
      sessionEpochRef.current += 1;
      busyRef.current = false;
      busyEpochRef.current = null;
      editGenerationRef.current += 1;
      editingRef.current = false;
      setIsPreparingEdit(false);
      setEditLoadError(null);
      savedSubmissionRef.current = null;
      setAutoEditAssisted(false);
      answerModeRef.current = "owner";
      setAnswerMode("owner");
      setSaveConfirmed(false);
      setAssistedScreen("closed");
      window.sessionStorage.removeItem(ASSISTED_MODE_KEY);
      quizzesRef.current = [];
      setQuizzes([]);
      selectionsRef.current = {};
      setSelections({});
      freeResponsesRef.current = {};
      setFreeResponses({});
      setLegacyAnswerIds([]);
      legacyAnswerIdsRef.current = [];
      setSavedSelections({});
      setAnsweredCount(0);
      submissionIdRef.current = null;
      setSubmissionId(null);
      revisionRef.current = 0;
      setRevision(0);
      failedAttemptRef.current = null;
      setRestoreError(null);
      void resolveParticipant(current.participant, "owner", false, undefined, true);
    },
    [resolveParticipant],
  );
  returnToOwnerRef.current = returnToOwner;

  const login = useCallback(async (name: string, pin: string): Promise<number> => {
    const currentAccess = accessRef.current;
    try {
      const { participant } = await createParticipantSession(name, pin);
      if (mountedRef.current) {
        sessionEpochRef.current += 1;
        busyRef.current = false;
        busyEpochRef.current = null;
        const sessionEpoch = sessionEpochRef.current;
        let mode: AnswerMode =
          window.sessionStorage.getItem(ASSISTED_MODE_KEY) === "assisted" ? "assisted" : "owner";
        if (currentAccess.kind === "reauthentication") {
          const sameParticipant = participant.id === currentAccess.participant.id;
          if (!sameParticipant) {
            editGenerationRef.current += 1;
            editingRef.current = false;
            setIsPreparingEdit(false);
            setEditLoadError(null);
            savedSubmissionRef.current = null;
            setAutoEditAssisted(false);
            window.sessionStorage.removeItem(ASSISTED_MODE_KEY);
            clearAssistedDraft();
            assistedParticipantIdRef.current = null;
            setAssistedParticipant(null);
            setAssistedScreen("closed");
            answerModeRef.current = "owner";
            setAnswerMode("owner");
            setSaveConfirmed(false);
          }
          if (ownerReturnAfterAssistedSaveRef.current && !sameParticipant) {
            ownerReturnAfterAssistedSaveRef.current = false;
          }
          if (!sameParticipant) {
            quizzesRef.current = [];
            setQuizzes([]);
            selectionsRef.current = {};
            setSelections({});
            freeResponsesRef.current = {};
            setFreeResponses({});
            setLegacyAnswerIds([]);
            legacyAnswerIdsRef.current = [];
            setSavedSelections({});
            setAnsweredCount(0);
            submissionIdRef.current = null;
            setSubmissionId(null);
            revisionRef.current = 0;
            setRevision(0);
            failedAttemptRef.current = null;
            setRestoreError(null);
            setPhase({ kind: "ready" });
          }
        }
        setAccess({ kind: "ready", participant });

        // The session is now authenticated. Resolve the initial view with one
        // scoped bootstrap so a new attempt receives its questions in the same
        // response instead of making latest and questions requests separately.
        setPhase({ kind: "checking-submission" });
        try {
          let bootstrap: AnswerBootstrap;
          try {
            bootstrap = await fetchAnswerBootstrap(mode);
          } catch (error) {
            if (mode !== "assisted" || !(error instanceof ApiError) || error.status !== 404) {
              throw error;
            }
            mode = "owner";
            answerModeRef.current = "owner";
            setAnswerMode("owner");
            window.sessionStorage.removeItem(ASSISTED_MODE_KEY);
            clearAssistedDraft();
            bootstrap = await fetchAnswerBootstrap("owner");
          }
          if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current)
            return participant.id;

          if (mode === "assisted" && bootstrap.submission !== null) {
            const assistedDraft = readAssistedDraft(bootstrap.participant.id);
            const draftMatchesSubmission = Boolean(
              assistedDraft &&
              assistedDraft.submissionId === bootstrap.submission.submissionId &&
              assistedDraft.revision === bootstrap.submission.revision,
            );
            if (!draftMatchesSubmission) {
              mode = "owner";
              answerModeRef.current = "owner";
              setAnswerMode("owner");
              setAssistedScreen("closed");
              setAssistedParticipant(null);
              assistedParticipantIdRef.current = null;
              window.sessionStorage.removeItem(ASSISTED_MODE_KEY);
              clearAssistedDraft();
              failedAttemptRef.current = null;
              savedSubmissionRef.current = null;
              quizzesRef.current = [];
              setQuizzes([]);
              submissionIdRef.current = null;
              setSubmissionId(null);
              revisionRef.current = 0;
              setRevision(0);
              selectionsRef.current = {};
              setSelections({});
              freeResponsesRef.current = {};
              setFreeResponses({});
              legacyAnswerIdsRef.current = [];
              setLegacyAnswerIds([]);
              setSavedSelections({});
              setAnsweredCount(0);
              setSaveConfirmed(false);
              setRestoreError(null);
              bootstrap = await fetchAnswerBootstrap("owner");
              if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current)
                return participant.id;
            }
          }

          const owner = bootstrap.owner;
          const target = bootstrap.participant;
          const submission = bootstrap.submission;
          let draft = mode === "assisted" ? readAssistedDraft(target.id) : null;
          const resumedSameParticipant =
            currentAccess.kind === "reauthentication" &&
            participant.id === currentAccess.participant.id &&
            bootstrap.owner.id === participant.id;
          answerModeRef.current = mode;
          setAnswerMode(mode);
          setAssistedScreen(mode === "assisted" ? "active" : "closed");
          setAssistedParticipant(
            mode === "assisted"
              ? { participant: target, hasSubmission: submission !== null, eligible: false }
              : null,
          );
          assistedParticipantIdRef.current = mode === "assisted" ? target.id : null;
          setAccess({ kind: "ready", participant: owner });
          setRestoreError(null);
          setSaveConfirmed(false);
          reloadedAssistedRef.current = mode === "assisted";

          const restoreDraft = (savedDraft: AssistedDraft) => {
            quizzesRef.current = savedDraft.quizzes;
            setQuizzes(savedDraft.quizzes);
            submissionIdRef.current = savedDraft.submissionId;
            setSubmissionId(savedDraft.submissionId);
            revisionRef.current = savedDraft.revision;
            setRevision(savedDraft.revision);
            selectionsRef.current = savedDraft.selections;
            setSelections(savedDraft.selections);
            freeResponsesRef.current = savedDraft.freeResponses;
            setFreeResponses(savedDraft.freeResponses);
            legacyAnswerIdsRef.current = savedDraft.legacyAnswerIds;
            setLegacyAnswerIds(savedDraft.legacyAnswerIds);
            setSavedSelections({});
            setAnsweredCount(
              Object.keys(savedDraft.selections).length +
                Object.values(savedDraft.freeResponses).filter((value) => value.trim()).length,
            );
            setPhase({ kind: "answering" });
          };

          if (mode === "owner") window.sessionStorage.removeItem(ASSISTED_MODE_KEY);
          if (submission === null) {
            savedSubmissionRef.current = null;
            const pendingAttemptMatchesScope =
              currentAccess.kind === "reauthentication" &&
              participant.id === currentAccess.participant.id &&
              bootstrap.owner.id === participant.id &&
              failedAttemptRef.current !== null &&
              submissionIdRef.current !== null &&
              quizzesRef.current.length === EXAM_QUESTION_COUNT &&
              (mode === "owner" || assistedParticipantIdRef.current === target.id);
            if (pendingAttemptMatchesScope) {
              reloadedAssistedRef.current = false;
              setPhase({
                kind: "answering",
                retryRequired: true,
                message: "参加状態を確認しました。回答案を確認してから、再度確定してください。",
              });
              return participant.id;
            }
            setSubmissionId(null);
            submissionIdRef.current = null;
            setRevision(0);
            revisionRef.current = 0;
            setSelections({});
            selectionsRef.current = {};
            setFreeResponses({});
            freeResponsesRef.current = {};
            setLegacyAnswerIds([]);
            legacyAnswerIdsRef.current = [];
            setSavedSelections({});
            setAnsweredCount(0);
            if (draft) {
              reloadedAssistedRef.current = false;
              restoreDraft(draft);
              return participant.id;
            }
            const loaded = bootstrap.questions!.map((question) => ({
              question,
              shuffled: shuffleChoices(question.choices),
            }));
            const id = newId();
            quizzesRef.current = loaded;
            setQuizzes(loaded);
            submissionIdRef.current = id;
            setSubmissionId(id);
            setPhase({ kind: "answering" });
            return participant.id;
          }

          const localSubmissionId = submissionIdRef.current;
          const localRevision = revisionRef.current;
          const hasLocalCorrectionDraft = quizzesRef.current.length === EXAM_QUESTION_COUNT;
          savedSubmissionRef.current = submission;
          if (
            resumedSameParticipant &&
            hasLocalCorrectionDraft &&
            localSubmissionId === submission.submissionId &&
            (mode === "owner" || assistedParticipantIdRef.current === target.id)
          ) {
            reloadedAssistedRef.current = false;
            setRestoreError(null);
            setSaveConfirmed(false);
            if (localRevision !== submission.revision) {
              preserveDraftOnSavedRefreshRef.current = true;
              failedAttemptRef.current = null;
              revisionRef.current = submission.revision;
              setRevision(submission.revision);
              setPhase({
                kind: "answering",
                refreshRequired: true,
                message: "保存済み回答が更新されています。最新の回答を確認してください。",
              });
            } else {
              preserveDraftOnSavedRefreshRef.current = false;
              setPhase({
                kind: "answering",
                retryRequired: Boolean(failedAttemptRef.current),
                message: failedAttemptRef.current
                  ? "参加状態を確認しました。回答案を確認してから、再度確定してください。"
                  : undefined,
              });
            }
            return participant.id;
          }

          if (
            resumedSameParticipant &&
            hasLocalCorrectionDraft &&
            localSubmissionId !== submission.submissionId
          ) {
            preserveDraftOnSavedRefreshRef.current = false;
            failedAttemptRef.current = null;
            quizzesRef.current = [];
            setQuizzes([]);
            selectionsRef.current = {};
            setSelections({});
            freeResponsesRef.current = {};
            setFreeResponses({});
            legacyAnswerIdsRef.current = [];
            setLegacyAnswerIds([]);
            setAnsweredCount(0);
            if (mode === "assisted") {
              clearAssistedDraft();
              draft = null;
            }
          }

          quizzesRef.current = [];
          setQuizzes([]);
          submissionIdRef.current = submission.submissionId;
          setSubmissionId(submission.submissionId);
          revisionRef.current = submission.revision;
          setRevision(submission.revision);
          if (
            mode === "assisted" &&
            draft &&
            draft.submissionId === submission.submissionId &&
            draft.revision === submission.revision
          ) {
            if (hasCompleteRestoreIntegrity(submission)) {
              reloadedAssistedRef.current = false;
              restoreDraft(draft);
            } else {
              setRestoreError(
                "保存済み回答の整合性を確認できません。確認のため再読み込みしてください。",
              );
              setAnsweredCount(0);
              setPhase({ kind: "complete" });
            }
            return participant.id;
          }
          if (mode === "assisted") {
            reloadedAssistedRef.current = false;
            clearAssistedDraft();
            window.sessionStorage.removeItem(ASSISTED_MODE_KEY);
            mode = "owner";
            answerModeRef.current = "owner";
            setAnswerMode("owner");
            setAssistedScreen("closed");
            setAssistedParticipant(null);
            assistedParticipantIdRef.current = null;
            setAutoEditAssisted(false);
            preserveDraftOnSavedRefreshRef.current = false;
            failedAttemptRef.current = null;
            savedSubmissionRef.current = null;
            quizzesRef.current = [];
            setQuizzes([]);
            submissionIdRef.current = null;
            setSubmissionId(null);
            revisionRef.current = 0;
            setRevision(0);
            selectionsRef.current = {};
            setSelections({});
            freeResponsesRef.current = {};
            setFreeResponses({});
            legacyAnswerIdsRef.current = [];
            setLegacyAnswerIds([]);
            setSavedSelections({});
            setAnsweredCount(0);
            setSaveConfirmed(false);
            setRestoreError(null);
            const ownerBootstrap = await fetchAnswerBootstrap("owner");
            if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current)
              return participant.id;
            setAccess({ kind: "ready", participant: ownerBootstrap.owner });
            savedSubmissionRef.current = ownerBootstrap.submission;
            if (ownerBootstrap.submission === null) {
              setSubmissionId(null);
              submissionIdRef.current = null;
              setRevision(0);
              revisionRef.current = 0;
              const ownerQuizzes = ownerBootstrap.questions!.map((question) => ({
                question,
                shuffled: shuffleChoices(question.choices),
              }));
              const newSubmissionId = newId();
              quizzesRef.current = ownerQuizzes;
              setQuizzes(ownerQuizzes);
              submissionIdRef.current = newSubmissionId;
              setSubmissionId(newSubmissionId);
              setSaveConfirmed(false);
              ownerReturnAfterAssistedSaveRef.current = false;
              setPhase({ kind: "answering" });
            } else {
              setSubmissionId(ownerBootstrap.submission.submissionId);
              submissionIdRef.current = ownerBootstrap.submission.submissionId;
              setRevision(ownerBootstrap.submission.revision);
              revisionRef.current = ownerBootstrap.submission.revision;
              const restoreIntegrityValid = hasCompleteRestoreIntegrity(ownerBootstrap.submission);
              if (!restoreIntegrityValid) {
                setAnsweredCount(0);
                setSaveConfirmed(false);
                setRestoreError(
                  "保存済み回答の整合性を確認できません。確認のため再読み込みしてください。",
                );
              } else {
                setSelections({});
                selectionsRef.current = {};
                setFreeResponses({});
                freeResponsesRef.current = {};
                setLegacyAnswerIds([]);
                legacyAnswerIdsRef.current = [];
                setSavedSelections({});
                setAnsweredCount(0);
                setSaveConfirmed(true);
                setRestoreError(null);
              }
              ownerReturnAfterAssistedSaveRef.current = false;
              setPhase(
                completedPhase(
                  restoreIntegrityValid ? ownerBootstrap.completionSnapshot : undefined,
                ),
              );
            }
            return participant.id;
          }
          if (!hasCompleteRestoreIntegrity(submission)) {
            setRestoreError(
              "保存済み回答の整合性を確認できません。確認のため再読み込みしてください。",
            );
            setAnsweredCount(0);
            setPhase({ kind: "complete" });
            return participant.id;
          }
          setSelections({});
          selectionsRef.current = {};
          setFreeResponses({});
          freeResponsesRef.current = {};
          setLegacyAnswerIds([]);
          legacyAnswerIdsRef.current = [];
          setSavedSelections({});
          setAnsweredCount(0);
          setSaveConfirmed(true);
          setPhase(completedPhase(bootstrap.completionSnapshot));
        } catch (error) {
          if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current)
            return participant.id;
          if (error instanceof ApiError && error.status === 401) {
            clearAssistedDraft();
            setAccess({ kind: "reauthentication", participant });
            setPhase({ kind: "ready" });
          } else {
            setPhase({
              kind: "submission-error",
              message: "回答状況を確認できませんでした。通信状態を確認して再試行してください。",
            });
          }
        }
      }
      return participant.id;
    } catch (error) {
      if (mountedRef.current) {
        setAccess(
          currentAccess.kind === "reauthentication"
            ? currentAccess
            : {
                kind: "login",
                message: error instanceof Error ? error.message : "参加できませんでした。",
              },
        );
      }
      throw error;
    }
  }, []);

  const switchParticipant = useCallback(async () => {
    const current = accessRef.current;
    if (current.kind !== "ready") return;
    setAccess({ kind: "switching", participant: current.participant });
    try {
      await deleteParticipantSession();
      if (!mountedRef.current) return;
      window.sessionStorage.removeItem(ASSISTED_MODE_KEY);
      clearAssistedDraft();
      assistedParticipantIdRef.current = null;
      savedSubmissionRef.current = null;
      setAutoEditAssisted(false);
      answerModeRef.current = "owner";
      setAnswerMode("owner");
      setSaveConfirmed(false);
      setAssistedScreen("closed");
      sessionEpochRef.current += 1;
      busyRef.current = false;
      busyEpochRef.current = null;
      editGenerationRef.current += 1;
      editingRef.current = false;
      setIsPreparingEdit(false);
      setEditLoadError(null);
      quizzesRef.current = [];
      setQuizzes([]);
      setSelections({});
      setFreeResponses({});
      freeResponsesRef.current = {};
      setLegacyAnswerIds([]);
      legacyAnswerIdsRef.current = [];
      selectionsRef.current = {};
      setSavedSelections({});
      setAnsweredCount(0);
      setSubmissionId(null);
      submissionIdRef.current = null;
      setRevision(0);
      revisionRef.current = 0;
      setRestoreError(null);
      failedAttemptRef.current = null;
      setPhase({ kind: "ready" });
      setAccess({ kind: "login" });
    } catch (error) {
      if (mountedRef.current) setAccess(current);
      throw error;
    }
  }, []);

  const select = useCallback(
    (questionId: number, selectedIndex: number) => {
      const currentPhase = phaseRef.current;
      if (
        busyRef.current ||
        currentPhase.kind !== "answering" ||
        currentPhase.retryRequired ||
        currentPhase.refreshRequired
      )
        return;
      const next = { ...selectionsRef.current, [questionId]: selectedIndex };
      selectionsRef.current = next;
      setSelections(next);
      setAnsweredCount(
        Object.keys(next).length +
          Object.values(freeResponsesRef.current).filter((value) => value.trim()).length,
      );
      persistAssistedDraft(next, freeResponsesRef.current);
      setPhase({ kind: "answering" });
    },
    [persistAssistedDraft],
  );

  const setFreeResponse = useCallback(
    (questionId: number, value: string) => {
      const next = { ...freeResponsesRef.current, [questionId]: value };
      freeResponsesRef.current = next;
      setFreeResponses(next);
      setAnsweredCount(
        Object.keys(selectionsRef.current).length +
          Object.values(next).filter((entry) => entry.trim()).length,
      );
      persistAssistedDraft(selectionsRef.current, next);
    },
    [persistAssistedDraft],
  );

  const saveAnswers = useCallback(async () => {
    const currentSubmissionId = submissionIdRef.current;
    if (!currentSubmissionId) return;
    const currentPhase = phaseRef.current;
    if (busyRef.current || currentPhase.kind !== "answering" || currentPhase.refreshRequired)
      return;
    const currentQuizzes = quizzesRef.current;
    const currentSelections = selectionsRef.current;
    if (
      currentQuizzes.length !== EXAM_QUESTION_COUNT ||
      currentQuizzes.some(({ question }) =>
        question.answerType === "freeText"
          ? !freeResponsesRef.current[question.id]?.trim() ||
            freeResponsesRef.current[question.id].trim().length > 1000
          : currentSelections[question.id] === undefined,
      )
    )
      return;
    const selectedByQuestion = copySelections(currentSelections) as Record<number, number>;
    const answers = currentQuizzes.map(({ question, shuffled }) =>
      question.answerType === "freeText"
        ? { questionId: question.id, freeText: freeResponsesRef.current[question.id].trim() }
        : {
            questionId: question.id,
            selectedIndex: shuffled.choiceIndices[selectedByQuestion[question.id]],
          },
    );
    const sameAnswers = (attempt: SaveAttempt) =>
      attempt.expectedRevision === revisionRef.current &&
      JSON.stringify(attempt.answers) === JSON.stringify(answers);
    let attempt = failedAttemptRef.current;
    if (!attempt || !sameAnswers(attempt)) {
      attempt = {
        operationId: newId(),
        expectedRevision: revisionRef.current,
        answers,
        selectedByQuestion,
        freeResponses: { ...freeResponsesRef.current },
      };
      failedAttemptRef.current = attempt;
    }
    const sessionEpoch = sessionEpochRef.current;
    const scope = answerModeRef.current;
    let returnToOwnerAfterSave = false;
    if (scope === "assisted" && assistedParticipantIdRef.current !== null) {
      persistAssistedDraft();
    }
    busyRef.current = true;
    busyEpochRef.current = sessionEpoch;
    setSaveConfirmed(false);
    setPhase({ kind: "submitting" });
    try {
      const result = await submitAnswerBatch(
        {
          submissionId: currentSubmissionId,
          operationId: attempt.operationId,
          expectedRevision: attempt.expectedRevision,
          answers: attempt.answers,
        },
        scope,
      );
      if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;
      if (result.submissionId !== currentSubmissionId) {
        setRestoreError("保存済み回答と現在の設問が一致しないため、回答を復元できません。");
        setSaveConfirmed(false);
        failedAttemptRef.current = null;
        setPhase({ kind: "complete" });
        return;
      }
      const confirmedSelections = { ...attempt.selectedByQuestion };
      const savedAnswers = attempt.answers.map((answer) =>
        "freeText" in answer
          ? {
              questionId: answer.questionId,
              answerKind: "freeText" as const,
              selectedIndex: null,
              freeText: attempt.freeResponses[answer.questionId]!,
            }
          : {
              questionId: answer.questionId,
              answerKind: "selected" as const,
              selectedIndex: answer.selectedIndex,
              freeText: null,
            },
      );
      savedSubmissionRef.current = {
        submissionId: result.submissionId,
        revision: result.revision,
        answers: savedAnswers,
        restoreIntegrity: {
          status: "complete",
          questions: currentQuizzes.map(({ question }) => ({
            id: question.id,
            answerType: question.answerType,
            choiceCount: question.choices.length,
          })),
        },
      };
      setSavedSelections(confirmedSelections);
      setSelections(confirmedSelections);
      setFreeResponses({ ...attempt.freeResponses });
      freeResponsesRef.current = { ...attempt.freeResponses };
      selectionsRef.current = confirmedSelections;
      setRevision(result.revision);
      revisionRef.current = result.revision;
      failedAttemptRef.current = null;
      setSaveConfirmed(true);
      setPhase(
        result.completionSnapshot?.status === "ready"
          ? { kind: "complete", completionSnapshot: result.completionSnapshot }
          : { kind: "complete" },
      );
      setRestoreError(null);
      if (scope === "assisted") {
        clearAssistedDraft();
        returnToOwnerAfterSave = true;
      }
    } catch (error) {
      if (mountedRef.current && sessionEpoch === sessionEpochRef.current) {
        if (error instanceof ApiError && error.status === 401) {
          const currentAccess = accessRef.current;
          if (currentAccess.kind === "ready")
            setAccess({ kind: "reauthentication", participant: currentAccess.participant });
        }
        if (
          error instanceof ApiError &&
          error.status === 423 &&
          error.code === "SUBMISSION_LOCKED"
        ) {
          setPhase({
            kind: "answering",
            publishedLock: true,
          });
          return;
        }
        if (error instanceof ApiError && error.status === 409) {
          try {
            const persisted = await fetchAnswerSubmission(currentSubmissionId, scope);
            if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;
            const restored = restoreSavedAnswers(
              persisted,
              quizzesRef.current,
              currentSubmissionId,
            );
            setLegacyAnswerIds(restored.legacyAnswerIds);
            setSavedSelections(restored.selections);
            setAnsweredCount(
              Object.keys(selectionsRef.current).length +
                Object.values(freeResponsesRef.current).filter((value) => value.trim()).length,
            );
            setRevision(persisted.revision);
            revisionRef.current = persisted.revision;
            failedAttemptRef.current = null;
            setPhase({
              kind: "answering",
              message:
                "保存済み回答が更新されています。回答案を保持しました。内容を確認して再度確定してください。",
            });
          } catch (refreshError) {
            if (mountedRef.current && sessionEpoch === sessionEpochRef.current) {
              if (refreshError instanceof InvalidSavedSubmissionError) {
                setRestoreError(refreshError.message);
                setSaveConfirmed(false);
                setPhase({ kind: "complete" });
                return;
              }
              const currentAccess = accessRef.current;
              if (
                refreshError instanceof ApiError &&
                refreshError.status === 401 &&
                currentAccess.kind === "ready"
              ) {
                setAccess({ kind: "reauthentication", participant: currentAccess.participant });
              }
              setPhase({
                kind: "answering",
                message:
                  "保存済み回答を読み込めませんでした。回答案は保持しています。状態を再確認してください。",
                refreshRequired: true,
              });
            }
          }
        } else {
          const resultMayBeUnknown =
            !(error instanceof ApiError) ||
            error.status >= 500 ||
            error.status === 401 ||
            error.status === 408 ||
            error.status === 429;
          setPhase({
            kind: "answering",
            message:
              error instanceof Error
                ? error.message
                : "回答を保存できませんでした。入力内容を保持しています。",
            retryRequired: resultMayBeUnknown,
          });
        }
      }
    } finally {
      if (busyEpochRef.current === sessionEpoch) {
        busyRef.current = false;
        busyEpochRef.current = null;
      }
      if (returnToOwnerAfterSave) returnToOwnerRef.current?.(true);
    }
  }, [persistAssistedDraft]);

  const refreshSavedAnswers = useCallback(async () => {
    const currentSubmissionId = submissionIdRef.current;
    if (!currentSubmissionId) return;
    const currentPhase = phaseRef.current;
    if (busyRef.current || currentPhase.kind !== "answering" || !currentPhase.refreshRequired)
      return;
    const sessionEpoch = sessionEpochRef.current;
    busyRef.current = true;
    busyEpochRef.current = sessionEpoch;
    setPhase({ kind: "refreshing" });
    try {
      const persisted = await fetchAnswerSubmission(currentSubmissionId, answerModeRef.current);
      if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;
      const restored = restoreSavedAnswers(persisted, quizzesRef.current, currentSubmissionId);
      const preserveLocalDraft = preserveDraftOnSavedRefreshRef.current;
      if (preserveLocalDraft) {
        preserveDraftOnSavedRefreshRef.current = false;
      } else {
        freeResponsesRef.current = restored.freeResponses;
        setFreeResponses(restored.freeResponses);
      }
      setLegacyAnswerIds(restored.legacyAnswerIds);
      setSavedSelections(restored.selections);
      const answerCountSelections = preserveLocalDraft
        ? selectionsRef.current
        : restored.selections;
      const answerCountFreeResponses = preserveLocalDraft
        ? freeResponsesRef.current
        : restored.freeResponses;
      setAnsweredCount(
        Object.keys(answerCountSelections).length +
          Object.values(answerCountFreeResponses).filter((value) => value.trim()).length,
      );
      setRevision(persisted.revision);
      revisionRef.current = persisted.revision;
      failedAttemptRef.current = null;
      setPhase({
        kind: "answering",
        message:
          "保存済み回答を読み込みました。編集中の回答案は保持されています。内容を確認して確定してください。",
      });
    } catch (error) {
      if (mountedRef.current && sessionEpoch === sessionEpochRef.current) {
        if (error instanceof InvalidSavedSubmissionError) {
          preserveDraftOnSavedRefreshRef.current = false;
          setRestoreError(error.message);
          setSaveConfirmed(false);
          setPhase({ kind: "complete" });
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          const currentAccess = accessRef.current;
          if (currentAccess.kind === "ready") {
            setAccess({ kind: "reauthentication", participant: currentAccess.participant });
          }
        }
        setPhase({
          kind: "answering",
          message: error instanceof Error ? error.message : "保存済み回答を読み込めませんでした。",
          refreshRequired: true,
        });
      }
    } finally {
      if (busyEpochRef.current === sessionEpoch) {
        busyRef.current = false;
        busyEpochRef.current = null;
      }
    }
  }, []);

  const editAnswers = useCallback(
    async (canEdit: () => boolean) => {
      const currentAccess = accessRef.current;
      if (currentAccess.kind !== "ready") return;
      if (phaseRef.current.kind !== "complete" || restoreError || editingRef.current) return;
      const saved = savedSubmissionRef.current;
      const integrity = saved?.restoreIntegrity;
      if (
        !saved ||
        integrity?.status !== "complete" ||
        !hasCompleteRestoreIntegrity(saved) ||
        !canEdit()
      )
        return;
      const snapshot = {
        sessionEpoch: sessionEpochRef.current,
        scope: answerModeRef.current,
        assistedParticipantId: assistedParticipantIdRef.current,
        submissionId: saved.submissionId,
        revision: revisionRef.current,
        participantId: currentAccess.participant.id,
      };
      editingRef.current = true;
      const editGeneration = ++editGenerationRef.current;
      const snapshotIsCurrent = () => {
        const currentAccess = accessRef.current;
        return (
          mountedRef.current &&
          editGenerationRef.current === editGeneration &&
          snapshot.sessionEpoch === sessionEpochRef.current &&
          snapshot.scope === answerModeRef.current &&
          snapshot.assistedParticipantId === assistedParticipantIdRef.current &&
          snapshot.submissionId === submissionIdRef.current &&
          snapshot.revision === revisionRef.current &&
          currentAccess.kind === "ready" &&
          currentAccess.participant.id === snapshot.participantId
        );
      };
      setIsPreparingEdit(true);
      setEditLoadError(null);
      try {
        let loaded = quizzesRef.current;
        const questionsMatchManifest = (items: LoadedQuiz[]) =>
          items.length === EXAM_QUESTION_COUNT &&
          items.every(({ question }, index) => {
            const expected = integrity.questions[index]!;
            return (
              expected.id === question.id &&
              expected.answerType === question.answerType &&
              expected.choiceCount === question.choices.length
            );
          });
        if (!questionsMatchManifest(loaded)) {
          const questions = await fetchExamQuestions();
          if (
            questions.length !== EXAM_QUESTION_COUNT ||
            new Set(questions.map(({ id }) => id)).size !== EXAM_QUESTION_COUNT ||
            questions.some(({ id }, index) => index > 0 && id <= questions[index - 1]!.id)
          ) {
            throw new Error("設問データを確認できませんでした。");
          }
          loaded = questions.map((question) => ({
            question,
            shuffled: shuffleChoices(question.choices),
          }));
        }
        if (!snapshotIsCurrent()) return;
        if (!questionsMatchManifest(loaded)) {
          setRestoreError("保存済み回答と現在の設問が一致しないため、回答を復元できません。");
          setSaveConfirmed(false);
          setPhase({ kind: "complete" });
          return;
        }
        if (!canEdit()) return;

        // The saved manifest validates answer shape and indices, and the loaded
        // questions are matched to it above before restoring display positions.
        const restored = restoreSavedAnswers(saved, loaded, snapshot.submissionId);
        quizzesRef.current = loaded;
        setQuizzes(loaded);
        setRestoreError(null);
        setSaveConfirmed(false);
        selectionsRef.current = restored.selections;
        freeResponsesRef.current = restored.freeResponses;
        setSelections(restored.selections);
        setSavedSelections(restored.selections);
        setFreeResponses(restored.freeResponses);
        setLegacyAnswerIds(restored.legacyAnswerIds);
        setAnsweredCount(
          Object.keys(restored.selections).length +
            Object.values(restored.freeResponses).filter((value) => value.trim()).length,
        );
        setPhase({ kind: "answering" });
      } catch {
        if (snapshotIsCurrent()) {
          setEditLoadError(
            "設問を読み込めませんでした。回答は確認済みです。もう一度お試しください。",
          );
        }
      } finally {
        if (editGenerationRef.current === editGeneration) {
          editingRef.current = false;
          setIsPreparingEdit(false);
        }
      }
    },
    [restoreError],
  );

  const clearAutoEditAssisted = useCallback(() => setAutoEditAssisted(false), []);

  const clearPublishedLock = useCallback(() => {
    const currentPhase = phaseRef.current;
    if (currentPhase.kind === "answering" && currentPhase.publishedLock) {
      setPhase({ kind: "answering" });
    }
  }, []);

  const retryLoad = useCallback(() => {
    if (phaseRef.current.kind === "load-error") void loadQuestions();
  }, [loadQuestions]);

  const retryEdit = useCallback(
    (canEdit: () => boolean) => {
      if (phaseRef.current.kind === "complete" && editLoadError) void editAnswers(canEdit);
    },
    [editAnswers, editLoadError],
  );

  return {
    answerMode,
    assistedScreen,
    assistedParticipant,
    assistedError,
    assistedBusy,
    openAssistedLogin,
    startAssisted,
    resumeAssisted,
    returnToOwner,
    access,
    phase,
    quizzes,
    selections,
    freeResponses,
    legacyAnswerIds,
    savedSelections,
    answeredCount,
    submissionId,
    revision,
    restoreError,
    saveConfirmed,
    isPreparingEdit,
    editLoadError,
    autoEditAssisted,
    clearAutoEditAssisted,
    select,
    setFreeResponse,
    saveAnswers,
    refreshSavedAnswers,
    editAnswers,
    clearPublishedLock,
    retryLoad,
    retryEdit,
    retrySubmissionCheck,
    login,
    switchParticipant,
  };
}
