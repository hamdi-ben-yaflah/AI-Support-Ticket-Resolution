import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function writeReportAtomically(path: string, report: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporaryPath, path);
}

async function main(): Promise<void> {
  const { parseEvaluationCliArguments } = await import("../src/evals/cli-options");
  const options = parseEvaluationCliArguments(process.argv.slice(2));
  const [{ runConfiguredEvaluation }, { formatEvaluationSummary }] = await Promise.all([
    import("../src/evals/service"),
    import("../src/evals/format"),
  ]);
  const rawMode = process.env.EVALUATION_MODE ?? "live";
  if (rawMode !== "live" && rawMode !== "record" && rawMode !== "replay") {
    throw new Error("Evaluation mode is invalid.");
  }
  const report = await runConfiguredEvaluation(options.concurrency, rawMode);
  await writeReportAtomically(options.output, report);
  process.stdout.write(formatEvaluationSummary(report));
  process.stdout.write(`Report: ${options.output}\n`);
  if (report.status !== "pass") process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "unexpected";
    process.stderr.write(
      `${JSON.stringify({ event: "evaluation_failed", code, message: "The evaluation could not be completed." })}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closeDatabase } = await import("../src/db/client");
    await closeDatabase();
  });
