# AI Engineering 04 — A corpus worth measuring, an ANN index, and a retrieval benchmark

**Status:** Proposed. One PR. Prerequisite for prompt 05 (hybrid retrieval and reranking).

## Concept primer (read this first)

### Why the current retrieval numbers cannot be trusted

`data/knowledge-base/` holds 8 Markdown files of 19 lines each — 152 lines total, which
chunks into roughly a dozen vectors. Every retrieval metric in the evaluation report is
computed over a corpus small enough that picking chunks at random would score respectably.
`retrievalRecallAt5 >= 0.9` over ~12 chunks with `finalCount = 5` is close to unfalsifiable.

A retrieval system only becomes interesting when the corpus contains things that are *almost*
the right answer: near-duplicate policies, superseded versions, adjacent products, and
documents that contradict each other. Those are what separate a good retriever from a lucky
one. So the first half of this PR is building a corpus that can actually fail.

### Exact search vs approximate search (ANN)

`src/db/knowledge.ts` runs `ORDER BY cosineDistance(embedding, $query) LIMIT n` against
`document_chunks`. With no index on the `embedding` column — and there is none across all four
migrations in `drizzle/` — PostgreSQL computes the distance between the query vector and
**every stored vector** on every search. That is an exact k-nearest-neighbour scan: perfect
recall, and cost linear in corpus size. At 12 chunks it is instant. At 100,000 chunks and
1,024 dimensions it is a multi-second sequential scan on every ticket.

The standard fix is an **ANN index** — approximate nearest neighbour. `pgvector` offers two:

- **IVFFlat** clusters vectors into lists and searches only the nearest few lists. It must be
  built *after* data exists (it needs the data to pick cluster centres), and it degrades as the
  data distribution shifts.
- **HNSW** (Hierarchical Navigable Small World) builds a layered proximity graph and walks it
  from a coarse layer down to a fine one. It is slower to build and larger on disk, but gives
  better recall-per-latency and can be created on an empty table. It is the default choice for
  a corpus that is rebuilt by ingestion.

"Approximate" means you trade recall for speed, and the trade is **tunable**:

- `m` and `ef_construction` are build-time knobs (graph connectivity and build effort).
- `ef_search` is a query-time knob: how many candidates to explore. Higher = better recall,
  slower.

Critically, the index must be built with the operator class matching your distance function.
This project uses cosine distance, so the index must use `vector_cosine_ops`. A mismatched
operator class means the planner ignores the index and you silently keep the sequential scan —
which is the single most common way this change gets shipped broken.

### Retrieval is measurable without an LLM

The existing evaluation runs the whole pipeline: classify, retrieve, generate, judge. That is
expensive and slow, and it conflates retrieval quality with generation quality. Retrieval has
its own, cheaper, fully deterministic metrics, computed from a list of `(query, relevant
document ids)` pairs:

- **recall@k** — of the documents that should have been found, what fraction appeared in the
  top k. This is the metric that matters most for RAG, because a chunk the retriever never
  returns is a fact the model cannot use.
- **MRR** (mean reciprocal rank) — 1/rank of the first relevant hit, averaged. Rewards putting
  the right thing first.
- **nDCG@k** — discounted cumulative gain. Rewards ranking all relevant documents highly, not
  just the first one.

A separate retrieval benchmark that reports these three at several `k` values, over a corpus
large enough to fail, is the artifact that demonstrates RAG competence. It is also what makes
prompt 05 reviewable: without it, "we added reranking" is an unverifiable claim.

## Objective

Grow the synthetic knowledge base to a size where retrieval quality is measurable, add a
correctly-configured HNSW index, and build a standalone retrieval benchmark that reports
recall@k, MRR, and nDCG@k plus query latency at several corpus sizes.

## Decisions

- The corpus stays **synthetic, Markdown, and version-controlled** — AGENTS.md is explicit and
  this PR does not change that. Generating it with an LLM offline and committing the output is
  fine; the committed Markdown is the source of truth, and ingestion stays deterministic.
- Target roughly 150–300 documents. Large enough that a sequential scan is visibly slower than
  an indexed search and that near-misses exist; small enough to ingest in CI in reasonable time
  and to stay reviewable in git.
- The corpus must be built **adversarially on purpose**: include near-duplicate policies that
  differ in one material condition, superseded policy versions, documents about adjacent
  products that share vocabulary, and at least one pair of genuinely contradictory statements.
  Record which is which in front matter so the benchmark and the abstention tests can use them.
- The retrieval benchmark is **separate from the golden eval** and calls no text model. It
  needs Voyage embeddings for the queries only, so it is cheap; cache query embeddings on disk
  so repeated runs are free.
- Index parameters are configuration, not magic numbers, and the chosen values must be
  justified by the recall/latency curve this PR produces.

## Scope

**Corpus**

- Expand `data/knowledge-base/` to the target size, preserving the existing front-matter schema
  (`KnowledgeDocumentFrontMatterSchema` in `src/domain/knowledge.ts`) and the "must begin with a
  heading" rule enforced in `src/ingestion/chunk-markdown.ts`.
- Add front-matter fields as needed to mark deliberately adversarial documents (near-duplicate
  of, supersedes, contradicts) — extend the Zod schema properly rather than smuggling them in.
- Verify ingestion still behaves: `pnpm ingest` is idempotent, unchanged sources skip,
  changed sources re-embed and replace transactionally.

**Index**

- Add a Drizzle migration creating an HNSW index on `document_chunks.embedding` with
  `vector_cosine_ops`. Set `m` and `ef_construction` explicitly.
- Add `RETRIEVAL_HNSW_EF_SEARCH` to `src/config/retrieval.ts`, applied per search transaction
  (`SET LOCAL hnsw.ef_search`) in `src/db/knowledge.ts`.
- Add a test or benchmark assertion that the index is actually used — capture `EXPLAIN` output
  for the search query and assert it is not a sequential scan. This is the check that catches a
  wrong operator class.

**Benchmark**

- Add `data/evals/retrieval-queries.jsonl`: query text plus the source IDs (and ideally chunk
  sections) that should be retrieved. Derive the first batch from the existing 36 golden cases
  so the two datasets stay consistent, then add queries that specifically probe the adversarial
  documents.
- Add `src/retrieval/benchmark.ts` computing recall@{1,3,5,10}, MRR, and nDCG@{5,10}, plus
  query latency p50/p95, over a given corpus and configuration.
- Add `scripts/retrieval-benchmark.ts` and a `pnpm bench:retrieval` script producing a JSON
  report and a printed table, in the same redacted-report style as `scripts/eval.ts`.
- Cache query embeddings on disk, keyed by input hash, so re-running is free.

## Non-goals

- Do not change the retrieval algorithm, thresholds, chunking strategy, or `finalCount` in this
  PR. This PR builds the measuring instrument and the corpus; prompt 05 changes the algorithm.
  Changing both at once makes the result uninterpretable.
- Do not add hybrid search, reranking, or query rewriting here.
- Do not raise `EVALUATION_THRESHOLDS`. The golden eval will shift because the corpus changed —
  re-baseline it honestly and report the new numbers, but do not tighten gates in the same PR.
- Do not add a knowledge-base admin UI or non-Markdown ingestion (AGENTS.md forbids both).

## Measurement (the deliverable)

Two tables in the PR description.

**1. Index effect.** Same corpus, same queries, exact scan vs HNSW at two or three `ef_search`
values:

| configuration | recall@5 | MRR | nDCG@10 | p50 query ms | p95 query ms |
|---|---|---|---|---|---|
| sequential scan (exact) | 1.000 | | | | |
| HNSW, ef_search = A | | | | | |
| HNSW, ef_search = B | | | | | |

The exact scan is your recall ceiling by definition. The point of the table is to show how much
recall the approximation costs and how much latency it buys, then justify the shipped value.

**2. Scaling.** Query latency at increasing corpus sizes, with and without the index, to
demonstrate the linear-versus-logarithmic difference. Synthetic padding chunks are acceptable
for the large sizes as long as you say so.

Also report the golden evaluation before and after the corpus change, and explain any metric
that moved. A drop in `retrievalRecallAt5` when the corpus grows is expected and honest — it
means the old number was easy.

## Documentation to update

- `README.md`: corpus size in the Evaluation section, the new `pnpm bench:retrieval` command in
  Useful commands, and a line in "What it demonstrates" about measured retrieval quality.
- `docs/operations/` — add `retrieval-benchmark.md`: what recall@k / MRR / nDCG mean and why
  each is reported, how to run the benchmark, how to read the recall-versus-latency trade-off,
  and the chosen HNSW parameters with the numbers that justify them.
- `AGENTS.md` §5: note the new index on `document_chunks` in the data-model description.
- `.env.example`: `RETRIEVAL_HNSW_EF_SEARCH`.

## How to review this PR

1. Open the migration. Confirm the operator class is `vector_cosine_ops` and that it matches
   the distance function used in `src/db/knowledge.ts`. This is the highest-risk line in the PR.
2. Find the `EXPLAIN` assertion. Without it, you cannot know the index is used.
3. Spot-check three of the new knowledge documents for the deliberate near-misses. If the new
   corpus is 200 documents that are all obviously distinct, it will not stress anything.
4. Read the scaling table. If latency is flat with and without the index, the corpus is still
   too small to prove anything and the benchmark needs bigger sizes.

## Verification

```bash
pnpm verify
pnpm ingest
pnpm bench:retrieval
pnpm eval:replay          # cassettes will need re-recording: the corpus changed
pnpm test:integration
```
