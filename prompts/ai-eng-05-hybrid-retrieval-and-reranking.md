# AI Engineering 05 — Hybrid retrieval and reranking

**Status:** Proposed. One PR. **Depends on prompt 04** — without the larger corpus and the
retrieval benchmark, nothing in this PR can be shown to work.

## Concept primer (read this first)

### Why embedding search alone is not enough

`retrieveEvidence` embeds the ticket text with Voyage and finds the chunks whose vectors are
closest by cosine similarity. This is **dense retrieval**, and its strength is semantic
matching: "I can't get into my account" finds a document titled "Login and verification" with
no shared vocabulary at all.

Its weakness is the mirror image. An embedding is a lossy summary of meaning, and exact
tokens dissolve into it. Dense retrieval is systematically weak on:

- **identifiers** — `INV-1042`, an order number, an error code like `ERR_PAYMENT_5031`;
- **rare proper nouns** — a product or plan name the embedding model never saw in training;
- **negation and small distinguishing conditions** — "refunds are available *except* on annual
  plans" and "refunds are available on annual plans" embed almost identically;
- **acronyms and jargon** specific to your domain.

Look at your own golden dataset: `eval-billing-duplicate-settled` contains
"invoices INV-1042 and INV-1043". Those identifiers are exactly what dense retrieval is worst
at and what a keyword index is best at.

### Lexical retrieval and BM25

The classical alternative is **lexical retrieval**: match on the words themselves, weighted by
how rare each word is across the corpus and how often it appears in the document. **BM25** is
the standard scoring function for this. PostgreSQL gives you a serviceable version natively via
`tsvector`, `to_tsquery`, and `ts_rank_cd`, with a GIN index — no new infrastructure, no new
dependency, and it lives in `src/db` exactly where AGENTS.md says SQL must live.

Lexical retrieval fails where dense retrieval succeeds: no shared words, no match.

### Hybrid retrieval and Reciprocal Rank Fusion

**Hybrid retrieval** runs both and merges the results. The naive merge — normalise both scores
and add them — is fragile, because cosine similarity and `ts_rank_cd` live on incomparable
scales that shift with corpus and query.

**Reciprocal Rank Fusion (RRF)** avoids the problem by throwing the scores away and using only
the ranks. For each document, score = sum over each result list of `1 / (k + rank)`, where `k`
is a small constant (60 is the conventional default) that damps the influence of the top
position. A document ranked #1 by one retriever and #40 by the other still beats a document
ranked #12 by both, but not by much. RRF is a handful of lines, has one parameter, and is hard
to get catastrophically wrong — which is why it is the default in practice.

### Reranking, and bi-encoders versus cross-encoders

Your embedding model is a **bi-encoder**: it encodes the query and each document
*independently* into vectors, then compares them. That independence is what makes it fast — the
document vectors are precomputed at ingestion time — and it is also what limits its accuracy,
because the model never sees the query and the document together.

A **cross-encoder** (a reranker) takes the query and one document *as a single input* and
outputs a relevance score. It can attend across both, so it is substantially more accurate. It
is also far more expensive, because nothing can be precomputed: scoring 50 candidates means 50
model passes.

This gives the standard **two-stage retrieval** shape:

1. **Retrieve** a generous candidate set cheaply — say top 50 by hybrid search.
2. **Rerank** those 50 with the cross-encoder and keep the top 5 for the prompt.

You pay cross-encoder cost on 50 documents instead of the whole corpus, and you typically win
back several points of precision at the top of the list. Because only the top few chunks reach
the prompt, precision at the top is exactly what matters for RAG.

### A governance constraint you must resolve first

`AGENTS.md` §4 currently states: "`voyageai`: embedding generation only", and the "Do not use"
list is strict about the retrieval stack. Using Voyage's reranking models is therefore
**outside the currently approved architecture** and requires an explicit amendment to
`AGENTS.md` before implementation, not after.

Decide up front, and record the decision in the PR:

- **Option A — hybrid only.** PostgreSQL `tsvector` + RRF. No new dependency, no AGENTS.md
  change, no added latency or per-request cost. Ship this regardless; it is the larger and
  safer win.
- **Option B — hybrid + hosted reranker.** Amend `AGENTS.md` §4 to permit `voyageai` for
  embeddings *and* reranking, with the same server-only constraints. Adds one network round
  trip inside the existing request deadline, and per-request cost.
- **Option C — hybrid + LLM reranker.** Score candidates with the small model from the prompt
  03 cascade. No AGENTS.md change to the provider list, but slower and less accurate than a
  purpose-built reranker, and it puts a text model inside the retrieval path.

The recommendation is: **do Option A in this PR, measure it, and treat the reranker as a
follow-up PR** with its own AGENTS.md amendment. Do not bundle an architecture-rule change with
an algorithm change.

## Objective

Add lexical retrieval alongside the existing dense retrieval, fuse the two with RRF, and prove
the improvement on the prompt 04 benchmark.

## Scope

- Add a `tsvector` column (generated, or maintained at ingestion) plus a GIN index on
  `document_chunks`, via a Drizzle migration. Choose and document the text-search
  configuration.
- Add a lexical candidate search to `src/db/knowledge.ts`, mirroring the existing
  `searchDocumentChunks` signature and honouring the same category filter.
- Add `src/retrieval/fusion.ts` implementing RRF as a pure, unit-tested function over ranked
  lists. It must be independent of the database and of Voyage.
- Wire it into `retrieveEvidence` in `src/retrieval/search.ts`: run both searches, fuse, then
  apply the existing `selectEvidence` threshold-and-token-budget logic.
  - **Important:** `selectEvidence` currently filters on `config.minimumSimilarity`, a cosine
    threshold. An RRF score is not a similarity and must not be compared against it. Decide
    deliberately whether the minimum-similarity gate applies to the dense leg before fusion, or
    whether a separate fused-score threshold is introduced — and say which, because this gate
    is what drives the `insufficient_evidence` abstention, a product-visible behaviour.
- Add `RETRIEVAL_MODE` (`dense` | `lexical` | `hybrid`, default `hybrid`) and `RETRIEVAL_RRF_K`
  to `src/config/retrieval.ts`, and bump the retrieval version string from `retrieval.v1` to
  `retrieval.v2` — it is recorded on every run and evaluation and must change when the
  algorithm changes.
- Extend `src/retrieval/benchmark.ts` from prompt 04 to run all three modes.
- Keep the existing category-filter fallback behaviour and its `fallbackUsed` telemetry
  working, and add span attributes for fusion (per-leg candidate counts, mode, RRF k).

## Non-goals

- No reranker in this PR (see Option A above).
- No query rewriting, HyDE, multi-query expansion, or embedding the classification summary
  instead of the raw ticket. All worthwhile; all separate PRs, because each independently moves
  the same metrics and bundling them makes attribution impossible.
- No chunking changes.
- No change to `finalCount`, `maximumContextTokens`, or the abstention policy value.

## Measurement (the deliverable)

From `pnpm bench:retrieval`, the mode comparison:

| mode | recall@5 | recall@10 | MRR | nDCG@10 | p50 ms | p95 ms |
|---|---|---|---|---|---|---|
| dense (today) | | | | | | |
| lexical only | | | | | | |
| hybrid RRF | | | | | | |

Then, from the golden evaluation, the end-to-end effect — because better retrieval is only
worth shipping if it changes outcomes:

| | dense | hybrid |
|---|---|---|
| retrievalRecallAt5 | | |
| citationSupport | | |
| actionAccuracy | | |
| **abstention rate** | | |
| p95 latency | | |
| cost USD | | |

Call out the query categories where each mode wins. The most convincing thing you can put in
this PR is a short list of specific queries that dense retrieval missed and hybrid found —
the invoice-identifier cases are the obvious candidates. That is the evidence that you
understood *why* you added lexical search rather than adding it because a blog post said to.

If hybrid does not beat dense on this corpus, say so and ship `RETRIEVAL_MODE=dense` as the
default. A negative result that is measured and documented is a stronger portfolio signal than
a positive result that is assumed.

## Documentation to update

- `README.md`: the retrieval description currently says "Category-first PostgreSQL + pgvector
  retrieval". Update it to describe hybrid retrieval and cite the measured numbers.
- `docs/operations/retrieval-benchmark.md` (created in prompt 04): add the fusion section —
  what RRF is, why rank fusion rather than score fusion, and how `RETRIEVAL_RRF_K` behaves.
- `AGENTS.md` §5: the new `tsvector` column and GIN index on `document_chunks`. §4 needs no
  change under Option A — note that explicitly in the PR so the decision is on the record.
- `.env.example`: `RETRIEVAL_MODE`, `RETRIEVAL_RRF_K`.

## How to review this PR

1. Find where `minimumSimilarity` is applied after fusion. If an RRF score is being compared
   against a cosine threshold, the abstention gate is now meaningless — this is the single most
   likely defect in this PR.
2. Confirm `retrieval.v1` became `retrieval.v2` everywhere it is recorded, and that the
   evaluation comparison refuses to compare across versions as it does today.
3. Check that `src/retrieval/fusion.ts` is a pure function with unit tests and no imports from
   `src/db` or the embedding provider.
4. Read the list of specific queries hybrid fixed. If it is absent, ask for it.

## Verification

```bash
pnpm verify
pnpm ingest                 # the tsvector column must be populated
pnpm bench:retrieval        # all three modes
pnpm eval:replay            # re-record: retrieval changed
pnpm eval -- --concurrency=3
pnpm test:integration
```
