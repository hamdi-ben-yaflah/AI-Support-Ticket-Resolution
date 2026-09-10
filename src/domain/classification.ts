import { z } from "zod";

export const CATEGORIES = ["billing", "technical", "account", "other"] as const;
export const PRIORITIES = ["low", "medium", "high"] as const;

export const ClassificationSchema = z.object({
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
  summary: z.string().trim().min(1).max(300),
  confidence: z.number().min(0).max(1),
});

export type Classification = z.infer<typeof ClassificationSchema>;
