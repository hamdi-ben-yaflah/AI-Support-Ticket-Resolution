import { resolve } from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDatabase, getDatabase } from "@/db/client";

async function main(): Promise<void> {
  await migrate(getDatabase(), { migrationsFolder: resolve(process.cwd(), "drizzle") });
  process.stdout.write(`${JSON.stringify({ event: "database_migrations_completed" })}\n`);
}

main()
  .catch(() => {
    process.stderr.write(
      `${JSON.stringify({ event: "database_migrations_failed", message: "Database migrations could not be applied." })}\n`,
    );
    process.exitCode = 1;
  })
  .finally(closeDatabase);
