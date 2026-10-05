"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnswerSubmission, Participant } from "@/lib/api/client";
import {
  ApiError,
  createParticipantSession,
  deleteParticipantSession,
  fetchAnswerSubmission,
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

type BatchAnswer = { questionId: number; selectedIndex: number };
type SaveAttempt = {
  operationId: string;
  expectedRevision: number;
  answers: BatchAnswer[];
  selectedByQuestion: Record<number, number>;
};

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
    const quiz = quizzes.find(({ question }) => question.id === answer.questionId);
    const displayIndex = quiz?.shuffled.choiceIndices.indexOf(answer.selectedIndex) ?? -1;
    if (displayIndex < 0) throw new Error("保存済み回答を問題に対応づけられませんでした。");
    restored[answer.questionId] = displayIndex;
  }
  if (Object.keys(restored).length !== EXAM_SIZE)
    throw new Error("保存済み回答の設問が正しくありません。");
  return restored;
}

export function useQuizSession() {
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });
  const [access, setAccess] = useState<AccessState>({ kind: "checking" });
  const [quizzes, setQuizzes] = useState<LoadedQuiz[]>([]);
  const [selections, setSelections] = useState<Record<number, number | undefined>>({});
  const [savedSelections, setSavedSelections] = useState<Record<number, number | undefined>>({});
  const [answeredCount, setAnsweredCount] = useState(0);
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const mountedRef = useRef(false);
  const busyRef = useRef(false);
  const quizzesRef = useRef(quizzes);
  const phaseRef = useRef(phase);
  const accessRef = useRef(access);
  const selectionsRef = useRef(selections);
  const submissionIdRef = useRef(submissionId);
  const revisionRef = useRef(revision);
  const failedAttemptRef = useRef<SaveAttempt | null>(null);
  phaseRef.current = phase;
  accessRef.current = access;
  quizzesRef.current = quizzes;
  selectionsRef.current = selections;
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

  const loadQuestions = useCallback(async (restart = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const initial = restart ? [] : quizzesRef.current;
    if (restart) {
      quizzesRef.current = [];
      setQuizzes([]);
      setSelections({});
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
        if (!mountedRef.current) return;
        if (!next) {
          quizzesRef.current = loaded;
          setQuizzes(loaded);
          setPhase({ kind: "shortage" });
          return;
        }
        loaded.push({ question: next, shuffled: shuffleChoices(next.choices) });
        quizzesRef.current = [...loaded];
        setQuizzes([...loaded]);
      }
      setPhase({ kind: "answering" });
    } catch {
      if (mountedRef.current) {
        quizzesRef.current = loaded;
        setQuizzes(loaded);
        setPhase({
          kind: "load-error",
          message: "問題を読み込めませんでした。通信状態を確認して、もう一度お試しください。",
        });
      }
    } finally {
      busyRef.current = false;
    }
  }, []);

  const start = useCallback(() => {
    if (accessRef.current.kind === "ready") void loadQuestions(true);
  }, [loadQuestions]);

  const login = useCallback(async (name: string, pin: string) => {
    const currentAccess = accessRef.current;
    try {
      const { participant } = await createParticipantSession(name, pin);
      if (mountedRef.current) setAccess({ kind: "ready", participant });
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
      selectionsRef.current = {};
      setSavedSelections({});
      setAnsweredCount(0);
      setSubmissionId(null);
      submissionIdRef.current = null;
      setRevision(0);
      revisionRef.current = 0;
      failedAttemptRef.current = null;
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
    setAnsweredCount(Object.keys(next).length);
    setPhase({ kind: "answering" });
  }, []);

  const saveAnswers = useCallback(async () => {
    const currentPhase = phaseRef.current;
    if (busyRef.current || currentPhase.kind !== "answering" || currentPhase.refreshRequired)
      return;
    const currentQuizzes = quizzesRef.current;
    const currentSelections = selectionsRef.current;
    if (
      currentQuizzes.length !== EXAM_SIZE ||
      currentQuizzes.some(({ question }) => currentSelections[question.id] === undefined)
    )
      return;
    const selectedByQuestion = copySelections(currentSelections) as Record<number, number>;
    const answers = currentQuizzes.map(({ question, shuffled }) => ({
      questionId: question.id,
      selectedIndex: shuffled.choiceIndices[selectedByQuestion[question.id]],
    }));
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
      const confirmedSelections = { ...attempt.selectedByQuestion };
      setSavedSelections(confirmedSelections);
      setSelections(confirmedSelections);
      selectionsRef.current = confirmedSelections;
      setRevision(result.revision);
      revisionRef.current = result.revision;
      failedAttemptRef.current = null;
      setPhase({ kind: "complete" });
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
            const restored = restoreDisplaySelections(persisted.answers, quizzesRef.current);
            setSavedSelections(restored);
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
      const restored = restoreDisplaySelections(persisted.answers, quizzesRef.current);
      setSavedSelections(restored);
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
    if (phaseRef.current.kind !== "complete") return;
    const restored = copySelections(savedSelections);
    selectionsRef.current = restored;
    setSelections(restored);
    setAnsweredCount(Object.keys(restored).length);
    setPhase({ kind: "answering" });
  }, [savedSelections]);

  const retryLoad = useCallback(() => {
    if (phaseRef.current.kind === "load-error") void loadQuestions();
  }, [loadQuestions]);

  return {
    access,
    phase,
    quizzes,
    selections,
    savedSelections,
    answeredCount,
    submissionId,
    revision,
    start,
    select,
    saveAnswers,
    refreshSavedAnswers,
    editAnswers,
    retryLoad,
    login,
    switchParticipant,
  };
}
