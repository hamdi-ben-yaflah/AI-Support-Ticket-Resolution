import { z } from "zod";

export const SourceDetailSchema = z
  .object({
    chunkId: z.string().uuid(),
    sourceId: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(300),
    section: z.string().trim().min(1).max(300),
    content: z.string().trim().min(1).max(20_000),
  })
  .strict();

export type SourceDetail = z.infer<typeof SourceDetailSchema>;
