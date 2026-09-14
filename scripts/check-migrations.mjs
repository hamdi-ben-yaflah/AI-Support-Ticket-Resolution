import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = process.cwd();
const sourceDirectory = join(repositoryRoot, "drizzle");
await mkdir(join(repositoryRoot, "node_modules/.cache"), { recursive: true });
const temporaryRoot = await mkdtemp(
  join(repositoryRoot, "node_modules/.cache/support-copilot-migrations-"),
);
const generatedDirectory = join(temporaryRoot, "drizzle");
const generatedDirectoryArgument = relative(repositoryRoot, generatedDirectory);

function runDrizzle(arguments_) {
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(executable, ["exec", "drizzle-kit", ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`drizzle-kit ${arguments_[0]} failed.`);
  }
}

async function snapshot(directory) {
  const entries = [];

  async function visit(current) {
    const children = await readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const path = join(current, child.name);
      if (child.isDirectory()) {
        await visit(path);
      } else if (child.isFile()) {
        const digest = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
        entries.push(`${relative(directory, path)}:${digest}`);
      }
    }
  }

  await visit(directory);
  return entries;
}

try {
  await cp(sourceDirectory, generatedDirectory, { recursive: true });
  const before = await snapshot(generatedDirectory);

  runDrizzle(["check", "--dialect", "postgresql", "--out", generatedDirectoryArgument]);
  runDrizzle([
    "generate",
    "--dialect",
    "postgresql",
    "--schema",
    "src/db/schema.ts",
    "--out",
    generatedDirectoryArgument,
  ]);

  const after = await snapshot(generatedDirectory);
  if (before.join("\n") !== after.join("\n")) {
    throw new Error(
      "Database schema and committed Drizzle migrations differ. Run pnpm db:generate and commit the result.",
    );
  }

  process.stdout.write("Committed Drizzle migrations match the database schema.\n");
} catch (error) {
  const message = error instanceof Error ? error.message : "Migration consistency check failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
