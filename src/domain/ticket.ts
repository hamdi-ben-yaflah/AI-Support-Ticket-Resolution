import { z } from "zod";

export const CUSTOMER_TIERS = ["standard", "premium"] as const;

export const TicketInputSchema = z
  .object({
    text: z.string().trim().min(10).max(10_000),
    customerTier: z.enum(CUSTOMER_TIERS).optional(),
  })
  .strict();

export type TicketInput = z.infer<typeof TicketInputSchema>;
