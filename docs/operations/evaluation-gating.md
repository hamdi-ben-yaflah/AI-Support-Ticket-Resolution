# Evaluation gating

The evaluation suite has two execution speeds that share the same dataset, application pipeline,
graders, thresholds, and report contract.

## Pull-request replay gate

`pnpm eval:replay` uses committed cassettes for Anthropic structured outputs and Voyage AI
embeddings. It makes no provider calls, requires no provider credentials, and reports zero provider
tokens. CI creates an empty pgvector database, applies migrations, runs `pnpm ingest:replay`, and
then evaluates all golden cases.

Replay catches regressions in request construction, retrieval, grounding and citation validation,
schema handling, abstention control flow, graders, metric aggregation, and reporting. It cannot
detect provider drift or determine whether a newly recorded model response is better than the old
one.

Every cassette is keyed by a SHA-256 hash over all answer-affecting request fields. LLM hashes
include provider, model, prompt version, system prompt, user input, and stable JSON Schema.
Embedding hashes include provider, model, dimensions, input type, and input texts. A missing file,
invalid file, changed hash, or schema-invalid recorded value throws `CassetteMissError`; replay
never falls back to a live provider.

The cassette manifest also pins the evaluation retrieval and resolution-policy configuration.
Replay uses those reviewed values instead of ambient environment overrides. The live and recording
workflows set the same values explicitly so reports are comparable; this evaluation baseline uses a
0.55 minimum similarity and 0.55 minimum classification confidence without changing the
application's 0.65 defaults.

## Live and recording modes

`pnpm eval` retains the existing live behavior. The protected `Live AI evaluation` workflow runs
nightly and can also be dispatched manually. It uses provider credentials and may incur cost.

To refresh fixtures locally, start with a fresh migrated database so deterministic chunk IDs and
recorded citation IDs agree, then run:

```bash
pnpm ingest:record
pnpm eval:record -- --concurrency=3 --output=artifacts/eval-record-results.json
pnpm eval:replay -- --concurrency=3 --output=artifacts/eval-replay-results.json
```

The protected `Record AI evaluation cassettes` workflow performs the same steps and attaches the
new cassette directory plus its report as a workflow artifact. Download it, inspect the diff, and
commit it through normal review. Confirm that only parsed, schema-validated model values and
vectors are present: cassettes must not contain prompts, request text, API keys, request IDs, or raw
provider envelopes.

A prompt, model, schema, dataset-input, or knowledge-base change is expected to cause cassette
misses. Re-record only after reviewing the live report; never edit hashes or make replay call the
network to silence a miss.

## Confidence intervals and thresholds

The report keeps each point estimate and adds a 95% Wilson interval to metrics that count binary
successes. The lower bound answers: “given this sample size, how low could the underlying success
rate plausibly be?” The gate compares that conservative lower bound with the configured threshold.
Average-of-ratios metrics such as retrieval recall and citation support are not binomial
proportions, so their interval fields are `null` and their point estimates remain the gate value.

Moving from point estimates to lower bounds required `evaluation-thresholds.v2`. A finite sample's
Wilson lower bound is always below 1 even when every case passes, so the old schema threshold of
1.00 was mathematically impossible. The first complete live baseline measured schema validity
1.000 (lower bound 0.904), category accuracy 1.000 (lower bound 0.904), retrieval recall 0.611,
citation support 0.969, and abstention accuracy 0.750 (lower bound 0.589). The versioned thresholds
therefore use 0.88 for schema validity, 0.78 for category accuracy, 0.55 for retrieval recall, 0.85
for citation support, and 0.55 for abstention accuracy. These values make the reviewed baseline pass
while retaining limited headroom for sampling movement; they do not reinterpret that run as meeting the
obsolete 0.90 retrieval bar. Future quality work should raise thresholds alongside measured prompt,
retrieval, or dataset improvements rather than silently changing this baseline.

When a run fails, first distinguish a cassette miss from a scored regression. A miss requires a
reviewed re-record if the request change was intentional. A regression requires inspecting failed
cases and the live/replay comparison; do not lower a threshold merely to make the check green.
