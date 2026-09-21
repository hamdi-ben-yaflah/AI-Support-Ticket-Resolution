"use client";

import { useEffect, useId, useMemo, useState } from "react";

import { createApiResultSchema } from "@/domain/api-result";
import {
  EvaluationComparisonSchema,
  EvaluationRunListSchema,
  type EvaluationCaseOutcome,
  type EvaluationComparison,
  type EvaluationRunSummary,
} from "@/evals/comparison-contracts";

const HistoryResultSchema = createApiResultSchema(EvaluationRunListSchema);
const ComparisonResultSchema = createApiResultSchema(EvaluationComparisonSchema);

type HistoryState =
  | { name: "loading" }
  | { name: "ready"; runs: EvaluationRunSummary[] }
  | { name: "failure"; message: string };

type ComparisonState =
  | { name: "idle" }
  | { name: "loading" }
  | { name: "ready"; comparison: EvaluationComparison }
  | { name: "failure"; message: string };

type CaseFilter = "regressed" | "improved" | "changed" | "all";

const QUALITY_LABELS = {
  schemaValidity: "Schema validity",
  categoryAccuracy: "Category accuracy",
  priorityAccuracy: "Priority accuracy",
  actionAccuracy: "Action accuracy",
  retrievalRecallAt5: "Retrieval recall@5",
  citationExistence: "Citation provenance",
  citationSupport: "Citation support",
  abstentionAccuracy: "Abstention accuracy",
  abstentionPrecision: "Abstention precision",
  abstentionRecall: "Abstention recall",
} as const;

const OPERATION_LABELS = {
  latencyP50Ms: "P50 latency (ms)",
  latencyP95Ms: "P95 latency (ms)",
  generationInputTokens: "Generation input tokens",
  generationOutputTokens: "Generation output tokens",
  judgeInputTokens: "Judge input tokens",
  judgeOutputTokens: "Judge output tokens",
  retryCount: "Retries",
  errorCount: "Errors",
  estimatedCostUsd: "Estimated cost (USD)",
} as const;

function compatible(left: EvaluationRunSummary, right: EvaluationRunSummary): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.dataset.version === right.dataset.version &&
    left.dataset.sha256 === right.dataset.sha256
  );
}

function formatPercent(value: number | null): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number | null, cost = false): string {
  if (value === null) return "N/A";
  return cost
    ? `$${value.toFixed(4)}`
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function signed(value: number | null, percent = false, cost = false): string {
  if (value === null) return "N/A";
  const amount = percent ? value * 100 : value;
  const formatted = cost
    ? amount.toFixed(4)
    : amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${amount > 0 ? "+" : ""}${cost ? "$" : ""}${formatted}${percent ? " pp" : ""}`;
}

function runLabel(run: EvaluationRunSummary): string {
  return `${new Date(run.completedAt).toLocaleString()} · ${run.runtime.models?.classification ?? run.runtime.model} → ${run.runtime.models?.resolution ?? run.runtime.model} · ${run.runId.slice(0, 8)}`;
}

function outcomeStyle(outcome: EvaluationCaseOutcome): string {
  if (outcome === "regressed") return "bg-[#f9dfda] text-[#983d35]";
  if (outcome === "improved") return "bg-[#ddf1e7] text-[#246146]";
  if (outcome === "changed") return "bg-[#fff0bd] text-[#765b0c]";
  return "bg-[#ecece7] text-[#66706c]";
}

function actualLabel(value: EvaluationComparison["cases"][number]["baseline"]["actual"]): string {
  return value ? `${value.category} / ${value.priority} / ${value.action}` : "No valid result";
}

function actualMetadataLabel(
  value: EvaluationComparison["cases"][number]["baseline"]["actual"],
): string {
  return value
    ? `${value.models?.classification ?? value.model} → ${value.models?.resolution ?? value.model} (${value.promptVersions.classification}, ${value.promptVersions.resolution})`
    : "N/A";
}

function scoreMovement(item: EvaluationComparison["cases"][number]): string {
  return (
    Object.entries(item.baseline.scores)
      .flatMap(([key, baseline]) => {
        const candidate = item.candidate.scores[key as keyof typeof item.candidate.scores];
        if (baseline === candidate) return [];
        const value = (score: boolean | number | null) =>
          typeof score === "boolean" ? (score ? "pass" : "fail") : formatPercent(score);
        return [`${key}: ${value(baseline)} → ${value(candidate)}`];
      })
      .join(", ") || "none"
  );
}

export function EvaluationHistory({ refreshVersion }: { refreshVersion: number }) {
  const baselineId = useId();
  const candidateId = useId();
  const [history, setHistory] = useState<HistoryState>({ name: "loading" });
  const [baseline, setBaseline] = useState("");
  const [candidate, setCandidate] = useState("");
  const [comparison, setComparison] = useState<ComparisonState>({ name: "idle" });
  const [filter, setFilter] = useState<CaseFilter>("regressed");

  useEffect(() => {
    const controller = new AbortController();
    async function loadHistory() {
      setHistory({ name: "loading" });
      try {
        const response = await fetch("/api/evaluations/runs?limit=20", {
          signal: controller.signal,
          cache: "no-store",
        });
        const parsed = HistoryResultSchema.safeParse(await response.json());
        if (!parsed.success || !parsed.data.ok) {
          setHistory({ name: "failure", message: "Saved evaluation history could not be loaded." });
          return;
        }
        const runs = parsed.data.data.runs;
        setHistory({ name: "ready", runs });
        setComparison({ name: "idle" });
        const newest = runs[0];
        setCandidate(newest?.runId ?? "");
        setBaseline(
          newest ? (runs.slice(1).find((run) => compatible(run, newest))?.runId ?? "") : "",
        );
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setHistory({ name: "failure", message: "Saved evaluation history is unavailable." });
        }
      }
    }
    void loadHistory();
    return () => controller.abort();
  }, [refreshVersion]);

  useEffect(() => {
    if (!baseline || !candidate || baseline === candidate) {
      return;
    }
    const controller = new AbortController();
    async function loadComparison() {
      setComparison({ name: "loading" });
      try {
        const params = new URLSearchParams({ baseline, candidate });
        const response = await fetch(`/api/evaluations/compare?${params}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const parsed = ComparisonResultSchema.safeParse(await response.json());
        if (!parsed.success) {
          setComparison({
            name: "failure",
            message: "The comparison response could not be verified.",
          });
        } else if (!parsed.data.ok) {
          const message =
            parsed.data.error.code === "evaluation_incompatible"
              ? "These runs cannot be compared because their report, dataset, or case set differs."
              : parsed.data.error.code === "evaluation_not_found"
                ? "One selected run no longer exists. Refresh the history and choose again."
                : "The selected evaluation runs could not be compared.";
          setComparison({ name: "failure", message });
        } else {
          setFilter("regressed");
          setComparison({ name: "ready", comparison: parsed.data.data });
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setComparison({ name: "failure", message: "The comparison request failed." });
        }
      }
    }
    void loadComparison();
    return () => controller.abort();
  }, [baseline, candidate]);

  const visibleCases = useMemo(() => {
    if (comparison.name !== "ready") return [];
    if (filter === "all") return comparison.comparison.cases;
    if (filter === "changed") {
      return comparison.comparison.cases.filter((item) => item.outcome !== "unchanged");
    }
    return comparison.comparison.cases.filter((item) => item.outcome === filter);
  }, [comparison, filter]);

  const runs = history.name === "ready" ? history.runs : [];

  return (
    <section aria-labelledby="history-title" className="mt-10 border-t border-[#deddd5] pt-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#71807a]">Story 8</p>
          <h2 id="history-title" className="mt-1 text-2xl font-semibold tracking-[-0.03em]">
            Saved runs and comparison
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#68736e]">
            Select an earlier baseline and a later candidate. Every delta is candidate minus
            baseline.
          </p>
        </div>
        {history.name === "ready" ? (
          <p className="text-xs text-[#74807b]">
            {runs.length} recent run{runs.length === 1 ? "" : "s"}
          </p>
        ) : null}
      </div>

      {history.name === "loading" ? (
        <p role="status" className="mt-5 rounded-xl bg-[#eaf4f0] p-4 text-sm text-[#285f52]">
          Loading saved evaluations…
        </p>
      ) : null}
      {history.name === "failure" ? (
        <p role="alert" className="mt-5 rounded-xl bg-[#fff0ed] p-4 text-sm text-[#8d3730]">
          {history.message}
        </p>
      ) : null}
      {history.name === "ready" && runs.length === 0 ? (
        <p className="mt-5 rounded-xl border border-dashed border-[#c9cbc5] p-5 text-sm text-[#68736e]">
          No saved runs yet. Complete an evaluation here or with <code>pnpm eval</code>.
        </p>
      ) : null}
      {history.name === "ready" && runs.length === 1 ? (
        <p className="mt-5 rounded-xl bg-[#fff8dc] p-4 text-sm text-[#6d581b]">
          One saved run is available. Complete another compatible run to compare versions.
        </p>
      ) : null}

      {runs.length > 0 ? (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-[#deddd5] bg-white">
          <table className="w-full min-w-[900px] text-left text-xs">
            <caption className="p-4 text-left text-base font-semibold">
              Recent evaluation history
            </caption>
            <thead className="bg-[#f0efe9] text-[#64706b]">
              <tr>
                <th className="px-4 py-2">Completed</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Dataset</th>
                <th className="px-4 py-2">Provider / model</th>
                <th className="px-4 py-2">Prompt versions</th>
                <th className="px-4 py-2">Schema / category</th>
                <th className="px-4 py-2">P95</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId} className="border-t border-[#e7e5dc]">
                  <td className="px-4 py-3">
                    <span className="block">{new Date(run.completedAt).toLocaleString()}</span>
                    <span className="font-mono text-[10px] text-[#74807b]">{run.runId}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-1 font-semibold ${run.status === "pass" ? "bg-[#ddf1e7] text-[#246146]" : "bg-[#f9dfda] text-[#983d35]"}`}
                    >
                      {run.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {run.dataset.version}
                    <span className="block font-mono text-[10px] text-[#74807b]">
                      {run.dataset.sha256.slice(0, 10)}… · {run.dataset.caseCount} cases
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {run.runtime.provider}
                    <span className="block font-semibold">
                      {run.runtime.models?.classification ?? run.runtime.model} →{" "}
                      {run.runtime.models?.resolution ?? run.runtime.model}
                    </span>
                    <span className="block text-[#74807b]">judge: {run.judgeModel}</span>
                  </td>
                  <td className="px-4 py-3">
                    {run.runtime.promptVersions.classification}
                    <span className="block">{run.runtime.promptVersions.resolution}</span>
                    <span className="block">{run.runtime.promptVersions.citationJudge}</span>
                  </td>
                  <td className="px-4 py-3">
                    {formatPercent(run.metrics.quality.schemaValidity.value)} /{" "}
                    {formatPercent(run.metrics.quality.categoryAccuracy.value)}
                  </td>
                  <td className="px-4 py-3">{run.metrics.operations.latencyP95Ms} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {runs.length >= 2 ? (
        <div className="mt-5 grid gap-4 rounded-2xl border border-[#deddd5] bg-white p-5 sm:grid-cols-2">
          <label htmlFor={baselineId} className="text-sm font-semibold">
            Baseline
            <select
              id={baselineId}
              value={baseline}
              onChange={(event) => {
                setComparison({ name: "idle" });
                setBaseline(event.target.value);
              }}
              className="mt-2 block h-11 w-full rounded-xl border border-[#cbcfc9] bg-white px-3 text-sm"
            >
              <option value="">Choose baseline</option>
              {runs.map((run) => (
                <option key={run.runId} value={run.runId} disabled={run.runId === candidate}>
                  {runLabel(run)}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={candidateId} className="text-sm font-semibold">
            Candidate
            <select
              id={candidateId}
              value={candidate}
              onChange={(event) => {
                setComparison({ name: "idle" });
                setCandidate(event.target.value);
              }}
              className="mt-2 block h-11 w-full rounded-xl border border-[#cbcfc9] bg-white px-3 text-sm"
            >
              <option value="">Choose candidate</option>
              {runs.map((run) => (
                <option key={run.runId} value={run.runId} disabled={run.runId === baseline}>
                  {runLabel(run)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {comparison.name === "idle" && runs.length >= 2 ? (
        <p className="mt-4 text-sm text-[#68736e]">Choose two different compatible runs.</p>
      ) : null}
      {comparison.name === "loading" ? (
        <p role="status" className="mt-4 rounded-xl bg-[#eaf4f0] p-4 text-sm text-[#285f52]">
          Comparing saved runs…
        </p>
      ) : null}
      {comparison.name === "failure" ? (
        <p role="alert" className="mt-4 rounded-xl bg-[#fff0ed] p-4 text-sm text-[#8d3730]">
          {comparison.message}
        </p>
      ) : null}

      {comparison.name === "ready" ? (
        <div className="mt-6 space-y-6">
          <div className="rounded-2xl bg-[#173f36] p-5 text-white">
            <div className="grid gap-5 lg:grid-cols-2">
              {[comparison.comparison.baseline, comparison.comparison.candidate].map(
                (run, index) => (
                  <div key={run.runId}>
                    <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#e9d983]">
                      {index === 0 ? "Baseline" : "Candidate"}
                    </p>
                    <p className="mt-2 font-semibold">
                      {run.runtime.models?.classification ?? run.runtime.model} →{" "}
                      {run.runtime.models?.resolution ?? run.runtime.model}
                    </p>
                    <p className="mt-1 font-mono text-xs text-[#c6d5d0]">{run.runId}</p>
                    <p className="mt-2 text-xs text-[#c6d5d0]">
                      Classify {run.runtime.promptVersions.classification} · Resolve{" "}
                      {run.runtime.promptVersions.resolution} · Judge{" "}
                      {run.runtime.promptVersions.citationJudge} ({run.judgeModel})
                    </p>
                  </div>
                ),
              )}
            </div>
            <div className="mt-5 border-t border-white/15 pt-4 text-sm">
              {comparison.comparison.versionDifferences.length > 0 ? (
                <ul className="grid gap-2 sm:grid-cols-2">
                  {comparison.comparison.versionDifferences.map((item) => (
                    <li key={item.field}>
                      <span className="text-[#abc0b9]">{item.label}:</span> {item.baseline} →{" "}
                      {item.candidate}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No model or prompt version changes were detected.</p>
              )}
            </div>
          </div>

          {comparison.comparison.configurationDifferences.length > 0 ? (
            <div
              role="note"
              className="rounded-2xl border border-[#ead9a2] bg-[#fff8dc] p-5 text-sm text-[#6d581b]"
            >
              <h3 className="font-semibold">Configuration drift may confound this comparison</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {comparison.comparison.configurationDifferences.map((item) => (
                  <li key={item.field}>
                    {item.label}: {item.baseline} → {item.candidate}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-2xl border border-[#deddd5] bg-white">
            <table className="w-full min-w-[680px] text-left text-sm">
              <caption className="p-4 text-left text-base font-semibold">Quality metrics</caption>
              <thead className="bg-[#f0efe9] text-xs text-[#64706b]">
                <tr>
                  <th className="px-4 py-2">Metric</th>
                  <th className="px-4 py-2">Baseline</th>
                  <th className="px-4 py-2">Candidate</th>
                  <th className="px-4 py-2">Delta</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(comparison.comparison.quality).map(([key, value]) => (
                  <tr key={key} className="border-t border-[#e7e5dc]">
                    <th className="px-4 py-3 font-medium">
                      {QUALITY_LABELS[key as keyof typeof QUALITY_LABELS]}
                    </th>
                    <td className="px-4 py-3">
                      {formatPercent(value.baseline.value)} ({value.baseline.numerator}/
                      {value.baseline.denominator})
                    </td>
                    <td className="px-4 py-3">
                      {formatPercent(value.candidate.value)} ({value.candidate.numerator}/
                      {value.candidate.denominator})
                    </td>
                    <td className="px-4 py-3 font-semibold">{signed(value.delta, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-[#deddd5] bg-white">
            <table className="w-full min-w-[680px] text-left text-sm">
              <caption className="p-4 text-left text-base font-semibold">
                Operational metrics
              </caption>
              <thead className="bg-[#f0efe9] text-xs text-[#64706b]">
                <tr>
                  <th className="px-4 py-2">Metric</th>
                  <th className="px-4 py-2">Baseline</th>
                  <th className="px-4 py-2">Candidate</th>
                  <th className="px-4 py-2">Delta</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(comparison.comparison.operations).map(([key, value]) => {
                  const cost = key === "estimatedCostUsd";
                  return (
                    <tr key={key} className="border-t border-[#e7e5dc]">
                      <th className="px-4 py-3 font-medium">
                        {OPERATION_LABELS[key as keyof typeof OPERATION_LABELS]}
                      </th>
                      <td className="px-4 py-3">{formatNumber(value.baseline, cost)}</td>
                      <td className="px-4 py-3">{formatNumber(value.candidate, cost)}</td>
                      <td className="px-4 py-3 font-semibold">
                        {signed(value.delta, false, cost)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="overflow-hidden rounded-2xl border border-[#deddd5] bg-white">
            <div className="flex flex-col gap-3 border-b border-[#deddd5] p-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h3 className="font-semibold">Case changes</h3>
                <p className="text-xs text-[#74807b]">
                  {comparison.comparison.caseSummary.regressed} regressions ·{" "}
                  {comparison.comparison.caseSummary.improved} improvements ·{" "}
                  {comparison.comparison.caseSummary.changed} other changes ·{" "}
                  {comparison.comparison.caseSummary.unchanged} unchanged
                </p>
              </div>
              <div className="flex flex-wrap gap-2" aria-label="Comparison case filter">
                {(["regressed", "improved", "changed", "all"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold ${filter === value ? "bg-[#173f36] text-white" : "bg-[#f0efe9] text-[#59645f]"}`}
                  >
                    {value === "all"
                      ? "All cases"
                      : value === "changed"
                        ? "All changed"
                        : value[0].toUpperCase() + value.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            {visibleCases.length === 0 ? (
              <p className="p-6 text-sm text-[#68736e]">No cases match this filter.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1100px] text-left text-xs">
                  <thead className="bg-[#f7f6f1] text-[#64706b]">
                    <tr>
                      <th className="px-4 py-2">Case</th>
                      <th className="px-4 py-2">Outcome</th>
                      <th className="px-4 py-2">Baseline → candidate</th>
                      <th className="px-4 py-2">Score movement</th>
                      <th className="px-4 py-2">Changed fields</th>
                      <th className="px-4 py-2">Latency Δ</th>
                      <th className="px-4 py-2">Token Δ</th>
                      <th className="px-4 py-2">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleCases.map((item) => (
                      <tr key={item.caseId} className="border-t border-[#e7e5dc]">
                        <th className="px-4 py-3 font-mono">{item.caseId}</th>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-full px-2 py-1 font-semibold ${outcomeStyle(item.outcome)}`}
                          >
                            {item.outcome}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="block font-semibold">
                            {item.baseline.passed ? "passed" : "failed"} →{" "}
                            {item.candidate.passed ? "passed" : "failed"}
                          </span>
                          <span className="mt-1 block">
                            {actualLabel(item.baseline.actual)} →{" "}
                            {actualLabel(item.candidate.actual)}
                          </span>
                          <span className="mt-1 block text-[10px] text-[#74807b]">
                            {actualMetadataLabel(item.baseline.actual)} →{" "}
                            {actualMetadataLabel(item.candidate.actual)}
                          </span>
                        </td>
                        <td className="px-4 py-3">{scoreMovement(item)}</td>
                        <td className="px-4 py-3">{item.changes.join(", ") || "none"}</td>
                        <td className="px-4 py-3">{signed(item.latencyDeltaMs)} ms</td>
                        <td className="px-4 py-3">{signed(item.tokenDelta)}</td>
                        <td className="px-4 py-3">
                          {item.baseline.error?.code ?? "none"} →{" "}
                          {item.candidate.error?.code ?? "none"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
