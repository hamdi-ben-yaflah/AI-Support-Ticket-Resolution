"use client";

import { useId, useMemo, useRef, useState } from "react";

import { createApiResultSchema } from "@/domain/api-result";
import {
  EvaluationReportSchema,
  type EvaluationMetric,
  type EvaluationReport,
} from "@/evals/contracts";
import { EVALUATION_THRESHOLDS } from "@/evals/thresholds";
import { EvaluationHistory } from "@/app/admin/evaluations/evaluation-history";

const EvaluationResultSchema = createApiResultSchema(EvaluationReportSchema);

type ViewState =
  | { name: "idle" }
  | { name: "running" }
  | { name: "complete"; report: EvaluationReport }
  | { name: "failure"; message: string; retryable: boolean };

const METRIC_LABELS = {
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

function formatPercent(value: number | null): string {
  return value === null ? "Not available" : `${(value * 100).toFixed(1)}%`;
}

function MetricCard({ label, metric }: { label: string; metric: EvaluationMetric }) {
  return (
    <div className="rounded-2xl border border-[#deddd5] bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#71807a]">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-[#173f36]">
        {formatPercent(metric.value)}
      </p>
      <p className="mt-1 text-xs text-[#7a8580]">
        {Number.isInteger(metric.numerator) ? metric.numerator : metric.numerator.toFixed(2)} /{" "}
        {metric.denominator}
      </p>
    </div>
  );
}

function CaseDetails({ item }: { item: EvaluationReport["cases"][number] }) {
  return (
    <details className="group border-t border-[#e7e5dc] px-4 py-3 first:border-t-0">
      <summary className="flex cursor-pointer list-none flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className="font-mono text-xs font-semibold text-[#285f52]">{item.caseId}</span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {item.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-[#f0efe9] px-2 py-0.5 text-[11px] text-[#64706b]"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
        <span
          className={`w-fit rounded-full px-2.5 py-1 text-xs font-bold ${
            item.passed ? "bg-[#ddf1e7] text-[#246146]" : "bg-[#f9dfda] text-[#983d35]"
          }`}
        >
          {item.passed ? "Passed" : "Failed"}
        </span>
      </summary>

      <div className="mt-4 grid gap-4 rounded-xl bg-[#f7f6f1] p-4 text-sm lg:grid-cols-2">
        <div>
          <h3 className="font-semibold text-[#26312d]">Expected</h3>
          <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-y-1 text-xs leading-5">
            <dt className="text-[#74807b]">Category</dt>
            <dd>{item.expected.category}</dd>
            <dt className="text-[#74807b]">Priority</dt>
            <dd>{item.expected.priorities.join(" / ")}</dd>
            <dt className="text-[#74807b]">Action</dt>
            <dd>{item.expected.actions.join(" / ")}</dd>
            <dt className="text-[#74807b]">Sources</dt>
            <dd>{item.expected.relevantSourceIds.join(", ") || "none"}</dd>
            <dt className="text-[#74807b]">Abstain</dt>
            <dd>{item.expected.shouldAbstain ? "yes" : "no"}</dd>
          </dl>
        </div>
        <div>
          <h3 className="font-semibold text-[#26312d]">Actual</h3>
          {item.actual ? (
            <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-y-1 text-xs leading-5">
              <dt className="text-[#74807b]">Category</dt>
              <dd>{item.actual.category}</dd>
              <dt className="text-[#74807b]">Priority</dt>
              <dd>{item.actual.priority}</dd>
              <dt className="text-[#74807b]">Action</dt>
              <dd>{item.actual.action}</dd>
              <dt className="text-[#74807b]">Confidence</dt>
              <dd>{formatPercent(item.actual.confidence)}</dd>
              <dt className="text-[#74807b]">Retrieved</dt>
              <dd>{item.actual.retrievedSourceIds.join(", ") || "none"}</dd>
              <dt className="text-[#74807b]">Cited</dt>
              <dd>{item.actual.citedSourceIds.join(", ") || "none"}</dd>
            </dl>
          ) : (
            <p className="mt-2 text-xs text-[#983d35]">No schema-valid execution was produced.</p>
          )}
        </div>
        <div>
          <h3 className="font-semibold text-[#26312d]">Grader outcomes</h3>
          <ul className="mt-2 grid grid-cols-2 gap-1 text-xs">
            {Object.entries(item.scores).map(([name, value]) => (
              <li key={name} className="flex justify-between gap-2 rounded bg-white px-2 py-1">
                <span>{name}</span>
                <span className="font-semibold">
                  {typeof value === "boolean" ? (value ? "pass" : "fail") : formatPercent(value)}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="font-semibold text-[#26312d]">Citation judge</h3>
          {item.judgeDecisions.length > 0 ? (
            <ul className="mt-2 space-y-2 text-xs">
              {item.judgeDecisions.map((decision) => (
                <li key={decision.citationId} className="rounded bg-white p-2">
                  <p className="font-mono text-[10px] text-[#74807b]">{decision.citationId}</p>
                  <p className="mt-1 font-semibold">
                    {decision.supported ? "Supported" : "Unsupported"}
                  </p>
                  <p className="mt-1 leading-5 text-[#59645f]">{decision.rationale}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-[#74807b]">No citation verdicts.</p>
          )}
          {item.error ? (
            <p role="alert" className="mt-3 rounded bg-[#f9dfda] p-2 text-xs text-[#8d3730]">
              {item.error.stage}: {item.error.message} ({item.error.code})
            </p>
          ) : null}
        </div>
      </div>
    </details>
  );
}

export function EvaluationConsole() {
  const concurrencyId = useId();
  const inFlight = useRef(false);
  const [concurrency, setConcurrency] = useState(3);
  const [filter, setFilter] = useState<"all" | "failed">("all");
  const [state, setState] = useState<ViewState>({ name: "idle" });
  const [historyRefreshVersion, setHistoryRefreshVersion] = useState(0);

  const report = state.name === "complete" ? state.report : null;
  const cases = useMemo(
    () => report?.cases.filter((item) => filter === "all" || !item.passed) ?? [],
    [filter, report],
  );

  async function run() {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ name: "running" });
    try {
      const response = await fetch("/api/evaluations/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ concurrency }),
      });
      const raw: unknown = await response.json();
      const parsed = EvaluationResultSchema.safeParse(raw);
      if (!parsed.success) {
        setState({
          name: "failure",
          message: "The evaluation response could not be verified.",
          retryable: false,
        });
      } else if (!parsed.data.ok) {
        setState({
          name: "failure",
          message:
            response.status === 409
              ? "Another evaluation is already running. Wait for it to finish and try again."
              : parsed.data.error.code === "configuration_error"
                ? "The live evaluation prerequisites are not configured."
                : "The evaluation could not be completed.",
          retryable: parsed.data.error.retryable,
        });
      } else {
        setFilter("all");
        setState({ name: "complete", report: parsed.data.data });
        setHistoryRefreshVersion((value) => value + 1);
      }
    } catch {
      setState({
        name: "failure",
        message: "The evaluation request failed before completion.",
        retryable: true,
      });
    } finally {
      inFlight.current = false;
    }
  }

  function downloadReport() {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `evaluation-${report.dataset.version}-${report.runId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="p-5 sm:p-8 lg:p-10">
      <div className="grid gap-6 lg:grid-cols-[1fr_1.35fr]">
        <div className="rounded-2xl border border-[#deddd5] bg-white p-5">
          <h2 className="text-xl font-semibold tracking-[-0.025em]">Run controls</h2>
          <p className="mt-2 text-sm leading-6 text-[#68736e]">
            Runs synchronously. The complete report stays in this tab while its safe comparison
            summary is saved to PostgreSQL.
          </p>
          <label htmlFor={concurrencyId} className="mt-5 block text-sm font-semibold">
            Concurrency
          </label>
          <select
            id={concurrencyId}
            value={concurrency}
            disabled={state.name === "running"}
            onChange={(event) => setConcurrency(Number(event.target.value))}
            className="mt-2 h-11 w-full rounded-xl border border-[#cbcfc9] bg-white px-3 text-sm outline-none focus:border-[#2d6b5c] focus:ring-4 focus:ring-[#2d6b5c]/10"
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={state.name === "running"}
            onClick={() => void run()}
            className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#e8ca62] px-5 text-sm font-bold text-[#19372f] transition hover:bg-[#f0d470] disabled:cursor-not-allowed disabled:bg-[#e3e1d8] disabled:text-[#939893]"
          >
            {state.name === "running" ? (
              <>
                <span
                  aria-hidden="true"
                  className="size-4 animate-spin rounded-full border-2 border-[#19372f]/25 border-t-[#19372f]"
                />
                Running evaluation…
              </>
            ) : (
              "Run evaluation"
            )}
          </button>
        </div>

        <div className="rounded-2xl border border-[#ead9a2] bg-[#fff8dc] p-5">
          <h2 className="font-semibold text-[#5f4b16]">Regression thresholds</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {Object.entries(EVALUATION_THRESHOLDS).map(([name, value]) => (
              <div
                key={name}
                className="flex justify-between rounded-lg bg-white/65 px-3 py-2 text-xs"
              >
                <span>{METRIC_LABELS[name as keyof typeof EVALUATION_THRESHOLDS]}</span>
                <strong>≥ {formatPercent(value)}</strong>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs leading-5 text-[#756325]">
            The citation judge uses the configured Anthropic model and is advisory. Optional cost
            appears only when both evaluation price variables are configured.
          </p>
        </div>
      </div>

      {state.name === "running" ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-6 rounded-2xl border border-[#bfd6ce] bg-[#eaf4f0] p-5 text-sm text-[#285f52]"
        >
          Running 36 cases with concurrency {concurrency}. This can take several minutes.
        </div>
      ) : null}
      {state.name === "failure" ? (
        <div
          role="alert"
          className="mt-6 rounded-2xl border border-[#e2aaa4] bg-[#fff0ed] p-5 text-sm text-[#8d3730]"
        >
          <p className="font-semibold">Evaluation failed</p>
          <p className="mt-1">{state.message}</p>
          {state.retryable ? <p className="mt-1">You can try again.</p> : null}
        </div>
      ) : null}

      {report ? (
        <div className="mt-8">
          <div
            role="status"
            className={`rounded-2xl border p-5 ${report.status === "pass" ? "border-[#9bc8b4] bg-[#e8f5ef] text-[#235d44]" : "border-[#e2aaa4] bg-[#fff0ed] text-[#8d3730]"}`}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.12em]">
                  {report.status === "pass" ? "Quality gate passed" : "Regression detected"}
                </p>
                <p className="mt-1 font-mono text-xs">Run {report.runId}</p>
              </div>
              <button
                type="button"
                onClick={downloadReport}
                className="rounded-xl border border-current px-4 py-2 text-sm font-bold"
              >
                Download JSON report
              </button>
            </div>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {Object.entries(report.metrics.quality).map(([name, metric]) => (
              <MetricCard
                key={name}
                label={METRIC_LABELS[name as keyof typeof METRIC_LABELS]}
                metric={metric}
              />
            ))}
          </div>

          <div className="mt-6 grid gap-3 rounded-2xl border border-[#deddd5] bg-[#173f36] p-5 text-white sm:grid-cols-3 lg:grid-cols-6">
            {[
              ["P50 latency", `${report.metrics.operations.latencyP50Ms} ms`],
              ["P95 latency", `${report.metrics.operations.latencyP95Ms} ms`],
              [
                "Generation tokens",
                String(
                  report.metrics.operations.generationInputTokens +
                    report.metrics.operations.generationOutputTokens,
                ),
              ],
              [
                "Judge tokens",
                String(
                  report.metrics.operations.judgeInputTokens +
                    report.metrics.operations.judgeOutputTokens,
                ),
              ],
              [
                "Errors / retries",
                `${report.metrics.operations.errorCount} / ${report.metrics.operations.retryCount}`,
              ],
              [
                "Estimated cost",
                report.metrics.operations.estimatedCostUsd === null
                  ? "Not configured"
                  : `$${report.metrics.operations.estimatedCostUsd.toFixed(4)}`,
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="text-xs text-[#abc0b9]">{label}</p>
                <p className="mt-1 font-semibold text-[#f8e28e]">{value}</p>
              </div>
            ))}
          </div>

          <div className="mt-6 overflow-hidden rounded-2xl border border-[#deddd5] bg-white">
            <div className="flex flex-col gap-3 border-b border-[#deddd5] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-semibold">Case inspection</h2>
                <p className="text-xs text-[#74807b]">
                  {cases.length} of {report.cases.length} cases
                </p>
              </div>
              <div className="flex gap-2" aria-label="Case filter">
                {(["all", "failed"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold ${filter === value ? "bg-[#173f36] text-white" : "bg-[#f0efe9] text-[#59645f]"}`}
                  >
                    {value === "all" ? "All cases" : "Failed cases"}
                  </button>
                ))}
              </div>
            </div>
            {cases.length > 0 ? (
              cases.map((item) => <CaseDetails key={item.caseId} item={item} />)
            ) : (
              <p className="p-6 text-sm text-[#68736e]">No failed cases in this report.</p>
            )}
          </div>
        </div>
      ) : null}

      <EvaluationHistory refreshVersion={historyRefreshVersion} />
    </section>
  );
}
