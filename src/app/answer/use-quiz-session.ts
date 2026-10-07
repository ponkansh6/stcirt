"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnswerSubmission, Participant } from "@/lib/api/client";
import {
  ApiError,
  createParticipantSession,
  deleteParticipantSession,
  fetchAnswerSubmission,
  fetchLatestAnswerSubmission,
  fetchNextQuestion,
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

function restoreDisplaySelections(
  answers: AnswerSubmission["answers"],
  quizzes: LoadedQuiz[],
): Record<number, number> {
  if (answers.length !== EXAM_SIZE) throw new Error("保存済み回答の数が正しくありません。");
  const restored: Record<number, number> = {};
  for (const answer of answers) {
    if (answer.answerKind === "legacy" || answer.answerKind === "freeText") continue;
    if (answer.selectedIndex === null)
      throw new Error("保存済み回答を問題に対応づけられませんでした。");
    const quiz = quizzes.find(({ question }) => question.id === answer.questionId);
    const displayIndex = quiz?.shuffled.choiceIndices.indexOf(answer.selectedIndex) ?? -1;
    if (displayIndex < 0) throw new Error("保存済み回答を問題に対応づけられませんでした。");
    restored[answer.questionId] = displayIndex;
  }
  if (
    Object.keys(restored).length !==
    quizzes.filter(({ question }) => question.answerType === "selected").length
  )
    throw new Error("保存済み回答の設問が正しくありません。");
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
      const answer = submission.answers.find((candidate) => candidate.questionId === question.id);
      if (!answer) throw new Error("missing answer");
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

    const selections = restoreDisplaySelections(submission.answers, quizzes);
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
  phaseRef.current = phase;
  accessRef.current = access;
  quizzesRef.current = quizzes;
  selectionsRef.current = selections;
  freeResponsesRef.current = freeResponses;
  submissionIdRef.current = submissionId;
  revisionRef.current = revision;

  useEffect(() => {
    mountedRef.current = true;
    void fetchParticipantSession()
      .then((participant) => {
        if (mountedRef.current)
          setAccess(participant ? { kind: "ready", participant } : { kind: "login" });
      })
      .catch(() => {
        if (mountedRef.current) {
          setAccess({
            kind: "login",
            message: "参加状態を確認できませんでした。お名前とPINを入力してください。",
          });
        }
      });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadQuestions = useCallback(async (restart = false): Promise<LoadedQuiz[] | null> => {
    if (busyRef.current) return null;
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
    const loaded: LoadedQuiz[] = [...initial];
    try {
      while (loaded.length < EXAM_SIZE) {
        const afterId = loaded.at(-1)?.question.id;
        const next = await fetchNextQuestion(afterId);
        if (!mountedRef.current) return null;
        if (!next) {
          quizzesRef.current = loaded;
          setQuizzes(loaded);
          setPhase({ kind: "shortage" });
          return null;
        }
        loaded.push({ question: next, shuffled: shuffleChoices(next.choices) });
        quizzesRef.current = [...loaded];
        setQuizzes([...loaded]);
      }
      setPhase({ kind: "answering" });
      return loaded;
    } catch {
      if (mountedRef.current) {
        quizzesRef.current = loaded;
        setQuizzes(loaded);
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
    async (participant: Participant) => {
      if (busyRef.current || checkingSubmissionRef.current) return;
      const resumingDraft =
        resumeAfterAuthRef.current &&
        (phaseRef.current.kind === "answering" || phaseRef.current.kind === "submitting");
      resumeAfterAuthRef.current = false;
      checkingSubmissionRef.current = true;
      resolvingParticipantIdRef.current = participant.id;
      setAccess({ kind: "ready", participant });
      setPhase({ kind: "checking-submission" });
      try {
        const latest = await fetchLatestAnswerSubmission();
        if (!mountedRef.current) return;
        if (!latest) {
          setRestoreError(null);
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

        submissionIdRef.current = latest.submissionId;
        setSubmissionId(latest.submissionId);
        revisionRef.current = latest.revision;
        setRevision(latest.revision);
        failedAttemptRef.current = null;
        const loaded = await loadQuestions();
        if (!mountedRef.current) return;
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
        if (!mountedRef.current) return;
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

  const retrySubmissionCheck = useCallback(() => {
    const current = accessRef.current;
    if (current.kind !== "ready" || checkingSubmissionRef.current || busyRef.current) return;
    resolvingParticipantIdRef.current = null;
    void resolveParticipant(current.participant);
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
  }, []);

  const saveAnswers = useCallback(async () => {
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
    const currentSubmissionId = submissionIdRef.current;
    if (!currentSubmissionId) return;
    busyRef.current = true;
    setPhase({ kind: "submitting" });
    try {
      const result = await submitAnswerBatch({
        submissionId: currentSubmissionId,
        operationId: attempt.operationId,
        expectedRevision: attempt.expectedRevision,
        answers: attempt.answers,
      });
      if (!mountedRef.current) return;
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
    } catch (error) {
      if (mountedRef.current) {
        if (error instanceof ApiError && error.status === 401) {
          const currentAccess = accessRef.current;
          if (currentAccess.kind === "ready")
            setAccess({ kind: "reauthentication", participant: currentAccess.participant });
        }
        if (error instanceof ApiError && error.status === 409) {
          try {
            const currentSubmissionId = submissionIdRef.current;
            if (!currentSubmissionId) throw new Error("提出情報を確認できませんでした。");
            const persisted = await fetchAnswerSubmission(currentSubmissionId);
            if (!mountedRef.current) return;
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
            if (mountedRef.current) {
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
  }, []);

  const refreshSavedAnswers = useCallback(async () => {
    const currentPhase = phaseRef.current;
    if (busyRef.current || currentPhase.kind !== "answering" || !currentPhase.refreshRequired)
      return;
    const currentSubmissionId = submissionIdRef.current;
    if (!currentSubmissionId) return;
    busyRef.current = true;
    setPhase({ kind: "refreshing" });
    try {
      const persisted = await fetchAnswerSubmission(currentSubmissionId);
      if (!mountedRef.current) return;
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
      if (mountedRef.current) {
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
