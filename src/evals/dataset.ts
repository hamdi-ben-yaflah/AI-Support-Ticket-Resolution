import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { EVALUATION_DATASET_VERSION, GoldenCaseSchema, type GoldenCase } from "@/evals/contracts";
import { EvaluationSetupError } from "@/evals/errors";

export type GoldenDataset = {
  version: typeof EVALUATION_DATASET_VERSION;
  sha256: string;
  cases: GoldenCase[];
};

export function parseGoldenDataset(contents: string): GoldenDataset {
  const normalized = contents.replaceAll("\r\n", "\n");
  const withoutTrailingNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const lines = withoutTrailingNewline.split("\n");

  if (lines.some((line) => line.trim().length === 0)) {
    throw new EvaluationSetupError("dataset", "The golden dataset contains a blank line.");
  }

  let cases: GoldenCase[];
  try {
    cases = lines.map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`Golden dataset line ${index + 1} is not valid JSON.`, {
          cause: error,
        });
      }
      return GoldenCaseSchema.parse(value);
    });
    z.array(GoldenCaseSchema).min(30).max(50).parse(cases);
  } catch (error) {
    if (error instanceof EvaluationSetupError) throw error;
    const message = error instanceof Error ? error.message : "The golden dataset is invalid.";
    throw new EvaluationSetupError("dataset", message, error);
  }

  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) {
      throw new EvaluationSetupError("dataset", `Duplicate evaluation case ID: ${item.id}`);
    }
    ids.add(item.id);
  }

  return {
    version: EVALUATION_DATASET_VERSION,
    sha256: createHash("sha256").update(contents).digest("hex"),
    cases,
  };
}

export async function loadGoldenDataset(
  path = resolve(process.cwd(), "data/evals/golden.jsonl"),
): Promise<GoldenDataset> {
  try {
    return parseGoldenDataset(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof EvaluationSetupError) throw error;
    throw new EvaluationSetupError("dataset", "The golden dataset could not be loaded.", error);
  }
}
