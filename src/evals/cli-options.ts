import { extname, resolve } from "node:path";

export type EvaluationCliOptions = { concurrency: number; output: string };

export function parseEvaluationCliArguments(
  rawArguments: readonly string[],
  workingDirectory = process.cwd(),
): EvaluationCliOptions {
  const arguments_ = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
  let concurrency = 3;
  let output = "artifacts/eval-results.json";
  const seen = new Set<string>();

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
    if (flag !== "--concurrency" && flag !== "--output") {
      throw new Error(`Unknown evaluation argument: ${flag ?? ""}`);
    }
    if (seen.has(flag)) throw new Error(`Duplicate evaluation argument: ${flag}`);
    seen.add(flag);
    const value = inlineValue ?? arguments_[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}.`);
    }
    if (inlineValue === undefined) index += 1;
    if (flag === "--concurrency") {
      concurrency = Number(value);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
        throw new Error("Concurrency must be an integer from 1 to 5.");
      }
    } else {
      output = value;
    }
  }

  const outputPath = resolve(workingDirectory, output);
  if (extname(outputPath).toLowerCase() !== ".json") {
    throw new Error("Evaluation output must be a JSON file.");
  }
  return { concurrency, output: outputPath };
}
