"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Participant } from "@/lib/api/client";
import { ApiError } from "@/lib/api/client";
import {
  createParticipantSession,
  deleteParticipantSession,
  fetchNextQuestion,
  fetchParticipantSession,
  submitAnswer,
} from "@/lib/api/client";
import type { QuizQuestion } from "@/types/quiz";
import { shuffleChoices, type ShuffledChoices } from "@/lib/shuffle";

const EXAM_SIZE = 5;

export type LoadedQuiz = { question: QuizQuestion; shuffled: ShuffledChoices };
export type Phase =
  | { kind: "ready" }
  | { kind: "loading" }
  | { kind: "shortage" }
  | {
      kind: "error";
      message: string;
      selectedIndex?: number;
      unavailable?: boolean;
      authenticationRequired?: boolean;
    }
  | { kind: "question"; selectedIndex?: number }
  | { kind: "submitting" }
  | { kind: "complete" };

export type AccessState =
  | { kind: "checking" }
  | { kind: "login"; message?: string }
  | { kind: "ready"; participant: Participant }
  | { kind: "switching"; participant: Participant }
  | { kind: "reauthentication"; participant: Participant };

export function useQuizSession() {
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });
  const [access, setAccess] = useState<AccessState>({ kind: "checking" });
  const [quizzes, setQuizzes] = useState<LoadedQuiz[]>([]);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [recordedCount, setRecordedCount] = useState(0);
  const mountedRef = useRef(false);
  const busyRef = useRef(false);
  const quizzesRef = useRef(quizzes);
  const phaseRef = useRef(phase);
  const accessRef = useRef(access);
  phaseRef.current = phase;
  accessRef.current = access;

  useEffect(() => {
    mountedRef.current = true;
    void fetchParticipantSession()
      .then((participant) => {
        if (mountedRef.current) {
          setAccess(participant ? { kind: "ready", participant } : { kind: "login" });
        }
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
      setQuestionIndex(0);
      setRecordedCount(0);
    }
    setPhase({ kind: "loading" });
    const loaded = [...initial];
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
      quizzesRef.current = loaded;
      setQuizzes(loaded);
      setQuestionIndex(0);
      setPhase({ kind: "question" });
    } catch {
      if (mountedRef.current) {
        quizzesRef.current = loaded;
        setQuizzes(loaded);
        setPhase({
          kind: "error",
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
      if (!mountedRef.current) return;
      const currentPhase = phaseRef.current;
      setAccess({ kind: "ready", participant });
      if (currentPhase.kind === "error" && currentPhase.authenticationRequired) {
        setPhase({
          kind: "error",
          selectedIndex: currentPhase.selectedIndex,
          message: "再ログインしました。選択した回答を確認してから、明示的に再送してください。",
        });
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
      setQuestionIndex(0);
      setRecordedCount(0);
      setPhase({ kind: "ready" });
      setAccess({ kind: "login" });
    } catch (error) {
      if (mountedRef.current) setAccess(current);
      throw error;
    }
  }, []);

  const select = useCallback((selectedIndex: number) => {
    if (phaseRef.current.kind !== "question") return;
    setPhase({ kind: "question", selectedIndex });
  }, []);

  const submitSelectedAnswer = useCallback(
    async (selectedIndex: number) => {
      if (busyRef.current) return;
      const quiz = quizzes[questionIndex];
      if (!quiz) return;
      busyRef.current = true;
      setPhase({ kind: "submitting" });
      const selectedOriginalIndex = quiz.shuffled.choiceIndices[selectedIndex];
      try {
        await submitAnswer(quiz.question.id, selectedOriginalIndex);
        if (!mountedRef.current) return;
        const nextRecordedCount = recordedCount + 1;
        setRecordedCount(nextRecordedCount);
        if (nextRecordedCount === EXAM_SIZE) {
          setPhase({ kind: "complete" });
        } else {
          setQuestionIndex((index) => index + 1);
          setPhase({ kind: "question" });
        }
      } catch (error) {
        if (mountedRef.current && error instanceof ApiError && error.status === 401) {
          const currentAccess = accessRef.current;
          if (currentAccess.kind === "ready") {
            setAccess({ kind: "reauthentication", participant: currentAccess.participant });
          }
          setPhase({
            kind: "error",
            message:
              "参加セッションの期限が切れました。再ログインしてください。回答はまだ送信されていません。",
            selectedIndex,
            authenticationRequired: true,
          });
        } else if (mountedRef.current) {
          setPhase({
            kind: "error",
            message: "回答を記録できませんでした。通信状態を確認して、回答を再送してください。",
            selectedIndex,
            unavailable: error instanceof ApiError && error.status === 404,
          });
        }
      } finally {
        busyRef.current = false;
      }
    },
    [quizzes, questionIndex, recordedCount],
  );

  const confirm = useCallback(() => {
    const current = phaseRef.current;
    if (current.kind !== "question" || current.selectedIndex === undefined) return;
    void submitSelectedAnswer(current.selectedIndex);
  }, [submitSelectedAnswer]);

  const retry = useCallback(() => {
    if (phaseRef.current.kind === "error") void loadQuestions(false);
  }, [loadQuestions]);

  const resendAnswer = useCallback(() => {
    const current = phaseRef.current;
    if (current.kind !== "error" || current.selectedIndex === undefined) return;
    void submitSelectedAnswer(current.selectedIndex);
  }, [submitSelectedAnswer]);

  return {
    access,
    phase,
    quiz: quizzes[questionIndex],
    questionIndex,
    recordedCount,
    select,
    confirm,
    retry,
    login,
    start,
    switchParticipant,
    resendAnswer,
    restart: () => void loadQuestions(true),
  };
}
