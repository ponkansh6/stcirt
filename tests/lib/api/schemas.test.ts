import { describe, expect, it } from "vitest";
import {
  answerBootstrapSchema,
  publicQuizQuestionSchema,
  submitAnswerBatchSchema,
} from "@/lib/api/schemas";

const submissionId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000002";
const owner = { id: 7, name: "参加者" };
const assisted = { id: 18, name: "代理回答者" };

const questions = () =>
  [1, 2, 3, 4, 5].map((id) => ({
    id,
    question: `Question ${id}`,
    choices: ["A", "B", "C", "D"],
    answerType: "selected" as const,
  }));

const savedSubmission = () => ({
  submissionId,
  revision: 1,
  answers: [],
});

const bootstrap = (overrides: Record<string, unknown> = {}) => ({
  mode: "owner",
  owner,
  participant: owner,
  submission: null,
  completionSnapshot: null,
  questions: questions(),
  ...overrides,
});

const completionSnapshot = {
  status: "ready" as const,
  identity: {
    scope: "owner" as const,
    ownerParticipantId: owner.id,
    participantId: owner.id,
    submissionId,
    revision: 1,
  },
  resultsState: "waiting" as const,
  resultsVisible: false,
};

describe("submitAnswerBatchSchema", () => {
  it("accepts selected and free-text answers", () => {
    const answers = [
      ...[1, 2, 3, 4].map((questionId) => ({ questionId, selectedIndex: 0 })),
      { questionId: 5, freeText: "An answer" },
    ];

    expect(
      submitAnswerBatchSchema.safeParse({
        submissionId,
        operationId,
        expectedRevision: 0,
        answers,
      }).success,
    ).toBe(true);
  });
});

describe("publicQuizQuestionSchema", () => {
  it.each([
    ["selected questions with fewer than two choices", { ...questions()[0], choices: ["A"] }],
    ["free-text questions with choices", { ...questions()[0], answerType: "freeText" }],
  ])("rejects %s", (_label, question) => {
    expect(publicQuizQuestionSchema.safeParse(question).success).toBe(false);
  });
});

describe("answerBootstrapSchema", () => {
  it("rejects an owner bootstrap whose participant ID does not match the owner", () => {
    expect(answerBootstrapSchema.safeParse(bootstrap({ participant: assisted })).success).toBe(
      false,
    );
  });

  it("requires questions when there is no saved submission", () => {
    const { questions: _questions, ...withoutQuestions } = bootstrap();
    expect(answerBootstrapSchema.safeParse(withoutQuestions).success).toBe(false);
  });

  it("rejects questions alongside a saved submission", () => {
    expect(
      answerBootstrapSchema.safeParse(
        bootstrap({ submission: savedSubmission(), completionSnapshot }),
      ).success,
    ).toBe(false);
  });

  it("rejects a saved submission without its completion snapshot", () => {
    expect(
      answerBootstrapSchema.safeParse(
        bootstrap({ submission: savedSubmission(), questions: undefined }),
      ).success,
    ).toBe(false);
  });

  it.each(["waiting", "visible", "unavailable"] as const)(
    "accepts the minimal %s completion result state",
    (resultsState) => {
      expect(
        answerBootstrapSchema.safeParse(
          bootstrap({
            submission: savedSubmission(),
            questions: undefined,
            completionSnapshot: { ...completionSnapshot, resultsState },
          }),
        ).success,
      ).toBe(true);
    },
  );

  it("accepts failed snapshots for saved submissions without conflating failure and no result", () => {
    const failedSnapshot = {
      status: "failed",
      identity: completionSnapshot.identity,
      resultsState: null,
      resultsVisible: null,
    } as const;
    expect(
      answerBootstrapSchema.safeParse(
        bootstrap({
          submission: savedSubmission(),
          questions: undefined,
          completionSnapshot: failedSnapshot,
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ["scope", { scope: "owner" }],
    ["owner participant", { ownerParticipantId: 8 }],
    ["target participant", { participantId: 19 }],
    ["submission", { submissionId: "00000000-0000-4000-8000-000000000009" }],
    ["revision", { revision: 2 }],
  ])("rejects a completion snapshot with mismatched %s identity", (_label, identityChange) => {
    const assistedSnapshot = {
      ...completionSnapshot,
      identity: {
        ...completionSnapshot.identity,
        scope: "assisted" as const,
        ownerParticipantId: owner.id,
        participantId: assisted.id,
        ...identityChange,
      },
    };
    expect(
      answerBootstrapSchema.safeParse(
        bootstrap({
          mode: "assisted",
          participant: assisted,
          submission: savedSubmission(),
          completionSnapshot: assistedSnapshot,
          questions: undefined,
        }),
      ).success,
    ).toBe(false);
  });

  it.each([
    ["duplicate", [1, 2, 3, 4, 4]],
    ["out-of-order", [1, 3, 2, 4, 5]],
  ])("rejects %s bootstrap question IDs", (_label, ids) => {
    const invalidQuestions = questions().map((question, index) => ({
      ...question,
      id: ids[index]!,
    }));

    expect(
      answerBootstrapSchema.safeParse(bootstrap({ questions: invalidQuestions })).success,
    ).toBe(false);
  });
});
