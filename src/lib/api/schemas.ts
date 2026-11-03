import { z } from "zod";
import { QUIZ_CHOICES_PER_QUESTION } from "@/lib/constants";

export const submitAnswerBatchSchema = z
  .object({
    submissionId: z.uuid(),
    operationId: z.uuid(),
    expectedRevision: z.number().int().min(0),
    answers: z
      .array(
        z
          .object({
            questionId: z.number().int().positive(),
            selectedIndex: z
              .number()
              .int()
              .min(0)
              .max(QUIZ_CHOICES_PER_QUESTION - 1),
          })
          .strict()
          .or(
            z
              .object({
                questionId: z.number().int().positive(),
                freeText: z.string().trim().min(1).max(1000),
              })
              .strict(),
          ),
      )
      .length(5),
  })
  .strict()
  .refine(({ answers }) => new Set(answers.map((answer) => answer.questionId)).size === 5, {
    message: "Question IDs must be unique",
    path: ["answers"],
  });

export const answerCompletionSnapshotSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      identity: z
        .object({
          scope: z.enum(["owner", "assisted"]),
          ownerParticipantId: z.number().int().positive(),
          participantId: z.number().int().positive(),
          submissionId: z.uuid(),
          revision: z.number().int().positive(),
        })
        .strict(),
      resultsState: z.enum(["waiting", "visible", "unavailable"]),
      resultsVisible: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      identity: z
        .object({
          scope: z.enum(["owner", "assisted"]),
          ownerParticipantId: z.number().int().positive(),
          participantId: z.number().int().positive(),
          submissionId: z.uuid(),
          revision: z.number().int().positive(),
        })
        .strict(),
      resultsState: z.null(),
      resultsVisible: z.null(),
    })
    .strict(),
]);

const answerSubmissionIdentitySchema = z.object({
  submissionId: z.uuid(),
  revision: z.number().int().positive(),
});

export const answerBatchResultSchema = answerSubmissionIdentitySchema.extend({
  completionSnapshot: answerCompletionSnapshotSchema,
});

export const answerSubmissionSchema = answerSubmissionIdentitySchema.extend({
  answers: z.array(
    z.object({
      questionId: z.number().int().positive(),
      answerKind: z.enum(["selected", "freeText", "legacy"]),
      selectedIndex: z.number().int().nullable(),
      freeText: z.string().nullable(),
    }),
  ),
  restoreIntegrity: z
    .discriminatedUnion("status", [
      z
        .object({
          status: z.literal("complete"),
          questions: z
            .array(
              z
                .object({
                  id: z.number().int().positive(),
                  answerType: z.enum(["selected", "freeText"]),
                  choiceCount: z.number().int().nonnegative(),
                })
                .strict(),
            )
            .length(5),
        })
        .strict(),
      z.object({ status: z.literal("invalid") }).strict(),
    ])
    .optional()
    .catch({ status: "invalid" as const }),
});

export const latestAnswerSubmissionSchema = z.object({
  submission: answerSubmissionSchema.nullable(),
});

export const publicQuizQuestionSchema = z
  .object({
    id: z.number().int().positive(),
    question: z.string().min(1),
    choices: z.array(z.string().min(1)),
    answerType: z.enum(["selected", "freeText"]),
  })
  .strict()
  .superRefine((question, context) => {
    if (question.answerType === "selected" && question.choices.length < 2) {
      context.addIssue({ code: "custom", message: "Selected questions require choices" });
    }
    if (question.answerType === "freeText" && question.choices.length !== 0) {
      context.addIssue({ code: "custom", message: "Free-text questions cannot expose choices" });
    }
  });

export const answerBootstrapSchema = z
  .object({
    mode: z.enum(["owner", "assisted"]),
    owner: z.object({ id: z.number().int().positive(), name: z.string() }).strict(),
    participant: z.object({ id: z.number().int().positive(), name: z.string() }).strict(),
    submission: answerSubmissionSchema.nullable(),
    completionSnapshot: answerCompletionSnapshotSchema.nullable(),
    questions: z
      .array(publicQuizQuestionSchema)
      .length(5)
      .superRefine((questions, context) => {
        const ids = questions.map(({ id }) => id);
        if (new Set(ids).size !== ids.length) {
          context.addIssue({ code: "custom", message: "Question IDs must be unique" });
        }
        if (ids.some((id, index) => index > 0 && id <= ids[index - 1]!)) {
          context.addIssue({ code: "custom", message: "Questions must be ordered by ID" });
        }
      })
      .optional(),
  })
  .strict()
  .superRefine((bootstrap, context) => {
    if (bootstrap.mode === "owner" && bootstrap.owner.id !== bootstrap.participant.id) {
      context.addIssue({
        code: "custom",
        message: "Owner bootstrap must use the owner as its answer participant",
        path: ["participant"],
      });
    }
    if (bootstrap.submission === null && bootstrap.questions === undefined) {
      context.addIssue({
        code: "custom",
        message: "A new attempt requires the complete public question batch",
        path: ["questions"],
      });
    }
    if (bootstrap.submission !== null && bootstrap.questions !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Saved submissions defer question loading until edit",
        path: ["questions"],
      });
    }
    if ((bootstrap.submission === null) !== (bootstrap.completionSnapshot === null)) {
      context.addIssue({
        code: "custom",
        message: "Completion snapshots are present only for saved submissions",
        path: ["completionSnapshot"],
      });
    }
    if (bootstrap.submission !== null && bootstrap.completionSnapshot !== null) {
      const { identity } = bootstrap.completionSnapshot;
      if (
        identity.scope !== bootstrap.mode ||
        identity.ownerParticipantId !== bootstrap.owner.id ||
        identity.participantId !== bootstrap.participant.id ||
        identity.submissionId !== bootstrap.submission.submissionId ||
        identity.revision !== bootstrap.submission.revision
      ) {
        context.addIssue({
          code: "custom",
          message: "Completion snapshot identity must match the saved submission scope",
          path: ["completionSnapshot", "identity"],
        });
      }
    }
  });
