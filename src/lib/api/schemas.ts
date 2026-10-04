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
