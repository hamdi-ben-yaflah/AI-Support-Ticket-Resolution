# AI Engineering 02 — Make evaluations gate the pipeline

**Status:** Proposed. One PR. Run before prompt 03 (model routing), which depends on this gate
to be credible.

## Concept primer (read this first)

In ordinary software you have unit tests: given an input, assert an exact output. LLM systems
cannot be tested that way — the output is text, it is non-deterministic even at temperature 0,
and "correct" is a judgement. The industry answer is an **evaluation suite** ("evals"): a
fixed dataset of inputs with expected *properties* rather than expected strings, scored by
graders, aggregated into metrics, and compared against thresholds.

This repository already has a very good one: `data/evals/golden.jsonl` (36 cases),
`src/evals/graders.ts`, `src/evals/thresholds.ts`, an LLM judge, and `scripts/eval.ts` which
exits non-zero when `report.status !== "pass"`.

And nothing runs it. `.github/workflows/ai-evaluation.yml` is `workflow_dispatch` only, and
`.github/workflows/pipeline.yml` never invokes it. A pull request can rewrite
`src/ai/prompts/resolve.v4.ts` and merge green. An eval suite that gates nothing is
documentation, not a control.

The reason it does not gate is real and worth understanding: the live eval calls Anthropic and
Voyage for every case, so it costs money and takes minutes. You cannot put that on every push.
The standard resolution is a **two-speed eval strategy**:

- **Offline / replay evals** run on every pull request. Provider responses are recorded once
  and replayed from disk ("cassettes", the same idea as VCR/nock in web testing). They are
  free, fast, deterministic, and network-free. They catch regressions in everything *around*
  the model: retrieval selection, grounding validation, citation provenance, graders, metric
  aggregation, abstention control flow, schema handling.
- **Live evals** run nightly and on demand. They cost money and catch what replay cannot:
  actual model-quality regressions from a prompt edit, a model version change, or provider
  drift.

The keystone detail: a cassette is keyed by a **hash of the request** (prompt version, system
prompt text, user input, output schema, model). So if someone edits a prompt, every cassette
misses, and the offline gate fails with "cassettes are stale — re-record". That is the
mechanism that makes prompt changes impossible to merge without a fresh live evaluation. It is
the whole point of the design; do not weaken it by falling back to live calls on a miss.

One more concept you will need: **threshold flapping**. `EVALUATION_THRESHOLDS` gates
`categoryAccuracy >= 0.9` on 36 cases. One case flipping moves that metric by 0.028. A gate on
a small, noisy sample fails randomly and teaches the team to ignore it. The fix is to report a
**confidence interval** alongside each rate (a Wilson interval is the standard choice for a
proportion) and gate on the interval's lower bound, so the gate fires on evidence of a
regression rather than on sampling noise.

## Objective

Make evaluation results block merges, without putting provider cost on every pull request, and
make the thresholds statistically honest enough that the gate is trusted.

## Decisions

- Two eval modes sharing one code path. The runner, graders, thresholds, and report schema are
  identical; only the provider implementation differs (live adapter vs replay adapter).
- Cassettes are **committed to the repository** as redacted fixtures. They are synthetic data
  about synthetic tickets, so this is safe — but the recorder must strip everything the project
  already refuses to persist, and the existing privacy tests must be extended to cover the
  cassette files.
- A cassette miss is a **hard failure**, never a silent live call and never a skip.
- The pull-request gate runs the replay eval. The nightly job runs the live eval and, on a
  separate explicit dispatch, re-records cassettes.
- Thresholds gate on the lower bound of a 95% Wilson interval for proportion metrics. Keep the
  existing point estimates in the report; add the interval next to them.

## Scope

**Replay infrastructure**

- Add `src/evals/replay.ts`: a `LlmProvider` implementation that resolves a request to a
  recorded response by request hash, and throws a typed `CassetteMissError` naming the case ID
  and the hash on a miss.
- Add a request-hashing function shared by the recorder and the replayer. Hash over: provider,
  model, prompt version, system prompt text, user input text, and a stable serialization of
  the output schema. Anything that can change the model's answer must be in the hash.
- Add a recording mode to the live path that writes cassettes to `data/evals/cassettes/`, one
  file per case and task (classification, resolution, judge).
- Do the same for Voyage embeddings — retrieval is part of what you are gating, and it must be
  deterministic offline. Record query embeddings by input hash; the ingested chunk embeddings
  come from the database, which CI already builds from committed Markdown.

**Statistics**

- Add `src/evals/statistics.ts` with a Wilson score interval for a proportion.
- Extend `EvaluationMetric` in `src/evals/contracts.ts` with `lowerBound` and `upperBound`
  (nullable, since an average-of-ratios metric is not a proportion — be explicit about which
  metrics get an interval and which do not).
- `evaluateThresholds` gates on `lowerBound` for proportion metrics. Keep `actual` in the
  report and in the printed summary so a human still sees the point estimate.
- Print intervals in `src/evals/format.ts` as `0.917 (95% CI 0.78–0.97)`.

**CI**

- Add an `evaluate-replay` job to `.github/workflows/pipeline.yml`: boots the pgvector service,
  migrates, ingests the committed knowledge base, runs the replay eval, uploads the report,
  and fails the build on `status !== "pass"` or on any cassette miss. It must require no
  provider secrets at all — assert that by not passing them to the job.
- Change `.github/workflows/ai-evaluation.yml` to add a nightly `schedule` trigger alongside
  `workflow_dispatch`, keeping the protected `ai-evaluation` environment.
- Add a `record-cassettes` workflow (`workflow_dispatch`, same protected environment) that
  runs the live eval in recording mode and opens or attaches the refreshed cassettes so a human
  reviews them.

**CLI**

- `pnpm eval:replay` — offline, network-free, no secrets.
- `pnpm eval:record` — live, writes cassettes.
- `pnpm eval` keeps its current live behaviour.

## Non-goals

- Do not change any prompt, threshold value, grader logic, or dataset case in this PR. If a
  threshold must move because the interval gate is stricter, do it as an explicit, separately
  justified commit inside this PR with the numbers that support it — never silently.
- Do not grow the golden dataset here (prompt 06 does that, and will need the
  `cases: z.array(...).min(30).max(50)` bound in `src/evals/contracts.ts` raised).
- Do not add judge calibration, per-case flakiness detection, or repeat-n variance runs. Worth
  doing later; not this PR.
- Do not make the live eval a required check on pull requests.

## Measurement

In the PR description, show:

- the replay eval's wall-clock time and the fact that it consumed zero provider tokens;
- a replay run and a live run of the same dataset version side by side, and an explanation of
  every metric that differs (they should be close; large divergence means the cassettes are
  not representative);
- one deliberately broken commit, reverted before merge, proving the gate fires — for example
  lower `RETRIEVAL_MINIMUM_SIMILARITY` handling or invert a grader, and paste the red CI run.
  A gate nobody has seen fail is not known to work.

## Documentation to update

- `README.md`: replace the current "not part of pull-request verification" framing in the
  Evaluation section with the two-speed model. Add `pnpm eval:replay` to Useful commands.
- `docs/operations/` — add `evaluation-gating.md`: the two modes, what each one can and cannot
  catch, how to re-record cassettes and why a prompt change forces it, and how to read a
  confidence interval in the report.
- `AGENTS.md` §1 step 8: the verification list should mention the replay evaluation as a
  standard check.
- `.env.example`: no new secrets; note explicitly that replay mode requires none.

## How to review this PR

1. Check the `evaluate-replay` CI job definition and confirm no `ANTHROPIC_API_KEY` or
   `VOYAGE_API_KEY` is passed to it. That is the proof it is genuinely offline.
2. Open one cassette file. Confirm it contains no raw ticket text beyond what is already
   committed in `golden.jsonl`, no API keys, and no provider response fields the project has
   promised not to store.
3. Find the cassette-miss test. Confirm a miss throws rather than falling back to a live call.
4. Look at the red CI run from the deliberately broken commit.

## Verification

```bash
pnpm verify
pnpm eval:replay                 # must pass with no network and no secrets
pnpm eval -- --concurrency=3     # live, compare against the replay report
```
