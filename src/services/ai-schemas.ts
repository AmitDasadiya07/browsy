import { z } from 'zod';

export const AiQualificationSchema = z.object({
  qualified: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export const AiNameExtractionSchema = z.object({
  first_name: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1),
});

export const ReplyCategorySchema = z.enum([
  'INTERESTED',
  'QUESTION',
  'PRICING',
  'CALL_REQUEST',
  'NOT_INTERESTED',
  'LATER',
  'OTHER',
]);

export const AiReplyClassificationSchema = z.object({
  category: ReplyCategorySchema,
  confidence: z.number().min(0).max(1),
  suggested_reply: z.string(),
});

export type AiQualification = z.infer<typeof AiQualificationSchema>;
export type AiNameExtraction = z.infer<typeof AiNameExtractionSchema>;
export type AiReplyClassification = z.infer<typeof AiReplyClassificationSchema>;
export type ReplyCategory = z.infer<typeof ReplyCategorySchema>;
