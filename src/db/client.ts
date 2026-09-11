import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getDatabaseConfig } from "@/config/database";

let pool: Pool | undefined;
let database: ReturnType<typeof drizzle> | undefined;

export function getDatabase() {
  if (!database) {
    pool = new Pool({ connectionString: getDatabaseConfig().databaseUrl });
    database = drizzle({ client: pool });
  }

  return database;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    database = undefined;
  }
}
