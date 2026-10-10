"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
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
  fetchLatestAnswerSubmission,
  fetchExamQuestions,
  fetchParticipantSession,
  submitAnswerBatch,
} from "@/lib/api/client";
import type { QuizQuestion } from "@/types/quiz";
import { shuffleChoices, type ShuffledChoices } from "@/lib/shuffle";

const EXAM_SIZE = 5;

export type LoadedQuiz = { question: QuizQuestion; shuffled: ShuffledChoices };
export type Phase =
  | { kind: "ready" }
  | { kind: "checking-submission" }
  | { kind: "submission-error"; message: string }
  | { kind: "loading" }
  | { kind: "shortage" }
  | { kind: "load-error"; message: string }
  | { kind: "answering"; message?: string; retryRequired?: boolean; refreshRequired?: boolean }
  | { kind: "submitting" }
  | { kind: "refreshing" }
  | { kind: "complete" };

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
const ASSISTED_DRAFT_KEY = "stcirt-assisted-answer-draft";

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
      submission.answers.length !== EXAM_SIZE ||
      quizzes.length !== EXAM_SIZE
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

type AssistedDraft = {
  quizzes: LoadedQuiz[];
  selections: Record<number, number>;
  freeResponses: Record<number, string>;
  submissionId: string;
  revision: number;
};

function readAssistedDraft(): AssistedDraft | null {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(ASSISTED_DRAFT_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const draft = value as Partial<AssistedDraft>;
    if (
      !Array.isArray(draft.quizzes) ||
      draft.quizzes.length !== EXAM_SIZE ||
      !draft.selections ||
      typeof draft.selections !== "object" ||
      !draft.freeResponses ||
      typeof draft.freeResponses !== "object" ||
      typeof draft.submissionId !== "string" ||
      !Number.isInteger(draft.revision)
    )
      return null;
    const ids = draft.quizzes.map(({ question }) => question.id);
    if (
      new Set(ids).size !== EXAM_SIZE ||
      ids.some((id, index) => index > 0 && id <= ids[index - 1]!) ||
      draft.quizzes.some(
        ({ question, shuffled }) =>
          !question ||
          !shuffled ||
          !Array.isArray(shuffled.choiceIndices) ||
          shuffled.choiceIndices.length !== question.choices.length ||
          new Set(shuffled.choiceIndices).size !== shuffled.choiceIndices.length,
      )
    )
      return null;
    return draft as AssistedDraft;
  } catch {
    return null;
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
  const [savedSelections, setSavedSelections] = useState<Record<number, number | undefined>>({});
  const [answeredCount, setAnsweredCount] = useState(0);
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const sessionEpochRef = useRef(0);
  const busyRef = useRef(false);
  const checkingSubmissionRef = useRef(false);
  const quizzesRef = useRef(quizzes);
  const phaseRef = useRef(phase);
  const accessRef = useRef(access);
  const selectionsRef = useRef(selections);
  const freeResponsesRef = useRef(freeResponses);
  const submissionIdRef = useRef(submissionId);
  const revisionRef = useRef(revision);
  const failedAttemptRef = useRef<SaveAttempt | null>(null);
  const resolvingParticipantIdRef = useRef<number | null>(null);
  const resumeAfterAuthRef = useRef(false);
  const assistedRequestRef = useRef(false);
  const answerModeRef = useRef<AnswerMode>("owner");
  answerModeRef.current = answerMode;
  phaseRef.current = phase;
  accessRef.current = access;
  quizzesRef.current = quizzes;
  selectionsRef.current = selections;
  freeResponsesRef.current = freeResponses;
  submissionIdRef.current = submissionId;
  revisionRef.current = revision;

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        const savedMode = window.sessionStorage.getItem(ASSISTED_MODE_KEY);
        let initialMode: AnswerMode = savedMode === "assisted" ? "assisted" : "owner";
        const participant = await fetchParticipantSession();
        let assisted: AssistedParticipantState | null = null;
        if (participant && initialMode === "assisted") {
          try {
            assisted = await fetchAssistedParticipant();
            if (!assisted.participant) initialMode = "owner";
          } catch {
            initialMode = "owner";
          }
        }
        if (!mountedRef.current) return;
        answerModeRef.current = initialMode;
        setAnswerMode(initialMode);
        setAssistedScreen(initialMode === "assisted" ? "active" : "closed");
        setAssistedParticipant(assisted);
        if (initialMode === "owner") window.sessionStorage.removeItem(ASSISTED_MODE_KEY);
        setAccess(participant ? { kind: "ready", participant } : { kind: "login" });
      } catch {
        if (mountedRef.current) {
          setAccess({
            kind: "login",
            message: "参加状態を確認できませんでした。お名前とPINを入力してください。",
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
    const initial = restart ? [] : quizzesRef.current;
    if (restart) {
      quizzesRef.current = [];
      setQuizzes([]);
      setSelections({});
      setFreeResponses({});
      freeResponsesRef.current = {};
      setLegacyAnswerIds([]);
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
      if (initial.length === EXAM_SIZE) {
        setPhase({ kind: "answering" });
        return initial;
      }
      const questions = await fetchExamQuestions();
      if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return null;
      if (
        questions.length !== EXAM_SIZE ||
        new Set(questions.map(({ id }) => id)).size !== EXAM_SIZE ||
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
      busyRef.current = false;
    }
  }, []);

  const resolveParticipant = useCallback(
    async (participant: Participant, scope: AnswerScope = answerModeRef.current) => {
      if (busyRef.current || checkingSubmissionRef.current) return;
      const sessionEpoch = sessionEpochRef.current;
      const resumingDraft = resumeAfterAuthRef.current && phaseRef.current.kind === "answering";
      resumeAfterAuthRef.current = false;
      checkingSubmissionRef.current = true;
      resolvingParticipantIdRef.current = participant.id;
      setAccess({ kind: "ready", participant });
      setPhase({ kind: "checking-submission" });
      try {
        const latest = await fetchLatestAnswerSubmission(scope);
        if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;
        if (!latest) {
          setRestoreError(null);
          if (scope === "assisted") {
            const draft = readAssistedDraft();
            if (draft) {
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
              setLegacyAnswerIds([]);
              const count =
                Object.keys(draft.selections).length +
                Object.values(draft.freeResponses).filter((value) => value.trim()).length;
              setAnsweredCount(count);
              setPhase({ kind: "answering" });
              return;
            }
          }
          if (resumingDraft && quizzesRef.current.length === EXAM_SIZE && submissionIdRef.current) {
            setPhase({
              kind: "answering",
              retryRequired: Boolean(failedAttemptRef.current),
              message: failedAttemptRef.current
                ? "参加状態を確認しました。回答案を確認してから、再度確定してください。"
                : undefined,
            });
            return;
          }
          await loadQuestions(true);
          return;
        }

        if (
          resumingDraft &&
          submissionIdRef.current === latest.submissionId &&
          quizzesRef.current.length === EXAM_SIZE
        ) {
          if (latest.revision !== revisionRef.current) {
            revisionRef.current = latest.revision;
            setRevision(latest.revision);
            failedAttemptRef.current = null;
            setPhase({
              kind: "answering",
              refreshRequired: true,
              message: "保存済み回答が更新されています。最新の回答を確認してください。",
            });
          } else {
            setPhase({
              kind: "answering",
              retryRequired: Boolean(failedAttemptRef.current),
              message: failedAttemptRef.current
                ? "参加状態を確認しました。回答案を確認してから、再度確定してください。"
                : undefined,
            });
          }
          return;
        }

        if (scope === "assisted") {
          const draft = readAssistedDraft();
          if (
            draft &&
            draft.submissionId === latest.submissionId &&
            draft.revision === latest.revision
          ) {
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
            setLegacyAnswerIds([]);
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

        submissionIdRef.current = latest.submissionId;
        setSubmissionId(latest.submissionId);
        revisionRef.current = latest.revision;
        setRevision(latest.revision);
        failedAttemptRef.current = null;
        const loaded = await loadQuestions();
        if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;
        if (!loaded) {
          setRestoreError(
            "保存済み回答を復元するための設問を読み込めませんでした。時間をおいて再読み込みしてください。",
          );
          setPhase({ kind: "complete" });
          return;
        }

        let restored: ReturnType<typeof restoreSavedAnswers>;
        try {
          restored = restoreSavedAnswers(latest, loaded);
        } catch {
          setRestoreError("保存済み回答と現在の設問が一致しないため、回答を復元できません。");
          setPhase({ kind: "complete" });
          return;
        }
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
        setRestoreError(null);
        setPhase({ kind: "complete" });
      } catch (error) {
        if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;
        if (error instanceof ApiError && error.status === 401) {
          resolvingParticipantIdRef.current = null;
          setAccess({
            kind: "login",
            message: "参加状態を確認できません。もう一度ログインしてください。",
          });
          setPhase({ kind: "ready" });
        } else {
          setPhase({
            kind: "submission-error",
            message: "回答状況を確認できませんでした。通信状態を確認して再試行してください。",
          });
        }
      } finally {
        checkingSubmissionRef.current = false;
      }
    },
    [loadQuestions],
  );

  useEffect(() => {
    if (access.kind !== "ready" || resolvingParticipantIdRef.current === access.participant.id)
      return;
    void resolveParticipant(access.participant);
  }, [access, resolveParticipant]);

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
        setAssistedError(
          error instanceof ApiError && error.status === 401
            ? "参加者セッションの有効期限が切れました。再ログインしてください。"
            : "ほかの人の回答状態を確認できませんでした。時間をおいて再読み込みしてください。",
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
    resolvingParticipantIdRef.current = null;
    void resolveParticipant(current.participant);
  }, [resolveParticipant]);

  const persistAssistedDraft = useCallback(
    (currentSubmissionId: string, currentQuizzes: LoadedQuiz[]) => {
      window.sessionStorage.setItem(
        ASSISTED_DRAFT_KEY,
        JSON.stringify({
          quizzes: currentQuizzes,
          selections: copyAnsweredSelections(selectionsRef.current),
          freeResponses: freeResponsesRef.current,
          submissionId: currentSubmissionId,
          revision: revisionRef.current,
        } satisfies AssistedDraft),
      );
    },
    [],
  );

  const openAssistedLogin = useCallback(() => {
    if (answerModeRef.current !== "owner" || phaseRef.current.kind !== "complete") return;
    setAssistedError(null);
    setAssistedScreen("login");
  }, []);

  const activateAssisted = useCallback(
    async (participant: Participant, hasSubmission: boolean, eligible = true) => {
      const current = accessRef.current;
      if (current.kind !== "ready" || busyRef.current || checkingSubmissionRef.current) return;
      sessionEpochRef.current += 1;
      answerModeRef.current = "assisted";
      setAnswerMode("assisted");
      setAssistedScreen("active");
      setAssistedParticipant({ participant, hasSubmission, eligible });
      setAssistedError(null);
      window.sessionStorage.setItem(ASSISTED_MODE_KEY, "assisted");
      quizzesRef.current = [];
      setQuizzes([]);
      selectionsRef.current = {};
      setSelections({});
      freeResponsesRef.current = {};
      setFreeResponses({});
      setLegacyAnswerIds([]);
      setSavedSelections({});
      setAnsweredCount(0);
      submissionIdRef.current = null;
      setSubmissionId(null);
      revisionRef.current = 0;
      setRevision(0);
      failedAttemptRef.current = null;
      setRestoreError(null);
      resolvingParticipantIdRef.current = null;
      await resolveParticipant(current.participant, "assisted");
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
    await activateAssisted(state.participant, state.hasSubmission, state.eligible);
  }, [activateAssisted, assistedParticipant]);

  const returnToOwner = useCallback(() => {
    if (assistedRequestRef.current) return;
    const current = accessRef.current;
    if (answerModeRef.current !== "assisted") {
      setAssistedScreen("closed");
      setAssistedError(null);
      return;
    }
    if (current.kind !== "ready") return;
    sessionEpochRef.current += 1;
    answerModeRef.current = "owner";
    setAnswerMode("owner");
    setAssistedScreen("closed");
    window.sessionStorage.removeItem(ASSISTED_MODE_KEY);
    quizzesRef.current = [];
    setQuizzes([]);
    selectionsRef.current = {};
    setSelections({});
    freeResponsesRef.current = {};
    setFreeResponses({});
    setLegacyAnswerIds([]);
    setSavedSelections({});
    setAnsweredCount(0);
    submissionIdRef.current = null;
    setSubmissionId(null);
    revisionRef.current = 0;
    setRevision(0);
    failedAttemptRef.current = null;
    setRestoreError(null);
    resolvingParticipantIdRef.current = null;
    void resolveParticipant(current.participant, "owner");
  }, [resolveParticipant]);

  const login = useCallback(async (name: string, pin: string) => {
    const currentAccess = accessRef.current;
    try {
      const { participant } = await createParticipantSession(name, pin);
      if (mountedRef.current) {
        if (currentAccess.kind === "reauthentication") {
          const sameParticipant = participant.id === currentAccess.participant.id;
          resumeAfterAuthRef.current = sameParticipant;
          resolvingParticipantIdRef.current = null;
          if (!sameParticipant) {
            quizzesRef.current = [];
            setQuizzes([]);
            selectionsRef.current = {};
            setSelections({});
            freeResponsesRef.current = {};
            setFreeResponses({});
            setLegacyAnswerIds([]);
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
      }
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
      window.sessionStorage.removeItem(ASSISTED_DRAFT_KEY);
      answerModeRef.current = "owner";
      setAnswerMode("owner");
      setAssistedScreen("closed");
      sessionEpochRef.current += 1;
      quizzesRef.current = [];
      setQuizzes([]);
      setSelections({});
      setFreeResponses({});
      freeResponsesRef.current = {};
      setLegacyAnswerIds([]);
      selectionsRef.current = {};
      setSavedSelections({});
      setAnsweredCount(0);
      setSubmissionId(null);
      submissionIdRef.current = null;
      setRevision(0);
      revisionRef.current = 0;
      setRestoreError(null);
      failedAttemptRef.current = null;
      resolvingParticipantIdRef.current = null;
      setPhase({ kind: "ready" });
      setAccess({ kind: "login" });
    } catch (error) {
      if (mountedRef.current) setAccess(current);
      throw error;
    }
  }, []);

  const select = useCallback((questionId: number, selectedIndex: number) => {
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
    if (answerModeRef.current === "assisted" && quizzesRef.current.length === EXAM_SIZE) {
      window.sessionStorage.setItem(
        ASSISTED_DRAFT_KEY,
        JSON.stringify({
          quizzes: quizzesRef.current,
          selections: next,
          freeResponses: freeResponsesRef.current,
          submissionId: submissionIdRef.current,
          revision: revisionRef.current,
        }),
      );
    }
    setPhase({ kind: "answering" });
  }, []);

  const setFreeResponse = useCallback((questionId: number, value: string) => {
    const next = { ...freeResponsesRef.current, [questionId]: value };
    freeResponsesRef.current = next;
    setFreeResponses(next);
    setAnsweredCount(
      Object.keys(selectionsRef.current).length +
        Object.values(next).filter((entry) => entry.trim()).length,
    );
    if (answerModeRef.current === "assisted" && quizzesRef.current.length === EXAM_SIZE) {
      window.sessionStorage.setItem(
        ASSISTED_DRAFT_KEY,
        JSON.stringify({
          quizzes: quizzesRef.current,
          selections: selectionsRef.current,
          freeResponses: next,
          submissionId: submissionIdRef.current,
          revision: revisionRef.current,
        }),
      );
    }
  }, []);

  const saveAnswers = useCallback(async () => {
    const currentSubmissionId = submissionIdRef.current;
    if (!currentSubmissionId) return;
    const currentPhase = phaseRef.current;
    if (busyRef.current || currentPhase.kind !== "answering" || currentPhase.refreshRequired)
      return;
    const currentQuizzes = quizzesRef.current;
    const currentSelections = selectionsRef.current;
    if (
      currentQuizzes.length !== EXAM_SIZE ||
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
    if (scope === "assisted") persistAssistedDraft(currentSubmissionId, currentQuizzes);
    busyRef.current = true;
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
        failedAttemptRef.current = null;
        setPhase({ kind: "complete" });
        return;
      }
      const confirmedSelections = { ...attempt.selectedByQuestion };
      setSavedSelections(confirmedSelections);
      setSelections(confirmedSelections);
      setFreeResponses({ ...attempt.freeResponses });
      freeResponsesRef.current = { ...attempt.freeResponses };
      selectionsRef.current = confirmedSelections;
      setRevision(result.revision);
      revisionRef.current = result.revision;
      failedAttemptRef.current = null;
      setPhase({ kind: "complete" });
      setRestoreError(null);
      if (scope === "assisted") window.sessionStorage.removeItem(ASSISTED_DRAFT_KEY);
    } catch (error) {
      if (mountedRef.current && sessionEpoch === sessionEpochRef.current) {
        if (error instanceof ApiError && error.status === 401) {
          const currentAccess = accessRef.current;
          if (currentAccess.kind === "ready")
            setAccess({ kind: "reauthentication", participant: currentAccess.participant });
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
            freeResponsesRef.current = restored.freeResponses;
            setFreeResponses(restored.freeResponses);
            setLegacyAnswerIds(restored.legacyAnswerIds);
            setSavedSelections(restored.selections);
            setAnsweredCount(
              Object.keys(restored.selections).length +
                Object.values(restored.freeResponses).filter((value) => value.trim()).length,
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
      busyRef.current = false;
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
    setPhase({ kind: "refreshing" });
    try {
      const persisted = await fetchAnswerSubmission(currentSubmissionId, answerModeRef.current);
      if (!mountedRef.current || sessionEpoch !== sessionEpochRef.current) return;
      const restored = restoreSavedAnswers(persisted, quizzesRef.current, currentSubmissionId);
      freeResponsesRef.current = restored.freeResponses;
      setFreeResponses(restored.freeResponses);
      setLegacyAnswerIds(restored.legacyAnswerIds);
      setSavedSelections(restored.selections);
      setAnsweredCount(
        Object.keys(restored.selections).length +
          Object.values(restored.freeResponses).filter((value) => value.trim()).length,
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
          setRestoreError(error.message);
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
      busyRef.current = false;
    }
  }, []);

  const editAnswers = useCallback(() => {
    if (phaseRef.current.kind !== "complete" || restoreError) return;
    const restored = copySelections(savedSelections);
    selectionsRef.current = restored;
    setSelections(restored);
    setAnsweredCount(
      Object.keys(restored).length +
        Object.values(freeResponsesRef.current).filter((value) => value.trim()).length,
    );
    setPhase({ kind: "answering" });
  }, [restoreError, savedSelections]);

  const retryLoad = useCallback(() => {
    if (phaseRef.current.kind === "load-error") void loadQuestions();
  }, [loadQuestions]);

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
    select,
    setFreeResponse,
    saveAnswers,
    refreshSavedAnswers,
    editAnswers,
    retryLoad,
    retrySubmissionCheck,
    login,
    switchParticipant,
  };
}
