"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { QuizQuestion } from "@/types/quiz";
import { shuffleChoices, type ShuffledChoices } from "@/lib/shuffle";
import { fetchNextQuestion, submitAnswer } from "@/lib/api/client";

const EXAM_SIZE = 5;

export type LoadedQuiz = { question: QuizQuestion; shuffled: ShuffledChoices };
export type Phase =
  | { kind: "loading" }
  | { kind: "shortage" }
  | { kind: "error"; message: string; selectedIndex?: number; unavailable?: boolean }
  | { kind: "question"; selectedIndex?: number }
  | { kind: "submitting" }
  | { kind: "complete" };

export function useQuizSession() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [quizzes, setQuizzes] = useState<LoadedQuiz[]>([]);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [recordedCount, setRecordedCount] = useState(0);
  const mountedRef = useRef(false);
  const busyRef = useRef(false);
  const quizzesRef = useRef(quizzes);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

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

  useEffect(() => {
    mountedRef.current = true;
    void loadQuestions(true);
    return () => {
      mountedRef.current = false;
    };
  }, [loadQuestions]); // A remount always starts a fresh exam.

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
      } catch (e) {
        if (mountedRef.current) {
          setPhase({
            kind: "error",
            message: "回答を記録できませんでした。通信状態を確認して、回答を再送してください。",
            selectedIndex,
            unavailable: e instanceof Error && /status 404\b/.test(e.message),
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
    if (phaseRef.current.kind === "error") {
      void loadQuestions(false);
    }
  }, [loadQuestions]);

  const resendAnswer = useCallback(() => {
    const current = phaseRef.current;
    if (current.kind !== "error" || current.selectedIndex === undefined) return;
    void submitSelectedAnswer(current.selectedIndex);
  }, [submitSelectedAnswer]);

  return {
    phase,
    quiz: quizzes[questionIndex],
    questionIndex,
    recordedCount,
    select,
    confirm,
    retry,
    resendAnswer,
    restart: () => void loadQuestions(true),
  };
}
