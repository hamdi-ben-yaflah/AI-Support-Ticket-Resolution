import "server-only";

import { sql } from "drizzle-orm";

import { getDeploymentConfig } from "@/config/deployment";
import { getDatabase } from "@/db/client";

export async function checkDatabaseReadiness(
  timeoutMs = getDeploymentConfig().databaseReadinessTimeoutMs,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Database readiness timed out.")), timeoutMs);
  });

  try {
    await Promise.race([getDatabase().execute(sql`select 1`), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
