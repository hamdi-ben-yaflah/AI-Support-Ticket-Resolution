import "server-only";

import { z } from "zod";

const DatabaseConfigSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith("postgres"), {
      message: "DATABASE_URL must use PostgreSQL.",
    }),
});

export type DatabaseConfig = {
  databaseUrl: string;
};

export function getDatabaseConfig(environment: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const parsed = DatabaseConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error("Database configuration is invalid or incomplete.");
  }

  return { databaseUrl: parsed.data.DATABASE_URL };
}
