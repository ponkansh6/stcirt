import { z } from "zod";
import { QUIZ_CHOICES_PER_QUESTION } from "@/lib/constants";

export const submitAnswerSchema = z.object({
  questionId: z.number().int().positive(),
  selectedIndex: z
    .number()
    .int()
    .min(0)
    .max(QUIZ_CHOICES_PER_QUESTION - 1),
});

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
          .strict(),
      )
      .length(5),
  })
  .strict()
  .refine(({ answers }) => new Set(answers.map((answer) => answer.questionId)).size === 5, {
    message: "Question IDs must be unique",
    path: ["answers"],
  });

export const answerBatchResultSchema = z.object({
  submissionId: z.uuid(),
  revision: z.number().int().positive(),
});

export const answerSubmissionSchema = answerBatchResultSchema.extend({
  answers: z.array(
    z.object({
      questionId: z.number().int().positive(),
      selectedIndex: z
        .number()
        .int()
        .min(0)
        .max(QUIZ_CHOICES_PER_QUESTION - 1),
    }),
  ),
});
