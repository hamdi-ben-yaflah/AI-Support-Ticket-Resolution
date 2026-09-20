# AI Engineering 08 — The feedback loop: production signal into the golden dataset

**Status:** Proposed. One PR. Independent of the others, but most useful after prompt 02, which
is what makes a growing dataset actually enforce anything.

## Concept primer (read this first)

### Offline evaluation versus online evaluation

Everything in `src/evals/` today is **offline evaluation**: a fixed dataset, run on demand,
scored against expectations written by hand. It tells you whether the system is good on the
36 cases someone thought of.

**Online evaluation** is the measurement of what the system actually did in production, on
inputs nobody anticipated. It is the only source of the cases you did not think of — and those
are, definitionally, the cases your offline suite is blind to.

Right now this repository has no online signal whatsoever. `resolution_runs` records what the
system *decided* (classification, action, tokens, latency) and nothing about whether the
decision was *right*. There is no column, no endpoint, and no UI affordance for a human to say
"this draft cited the wrong policy." So there is no path from production back into
`golden.jsonl`, and the dataset can only ever grow by someone sitting down and imagining new
cases.

### The data flywheel

The loop that every serious LLM product runs looks like this:

1. Production traffic produces outcomes.
2. Humans label a sample of those outcomes (and all the complaints).
3. Labelled failures become new evaluation cases.
4. The evaluation suite catches the next regression of that kind.
5. Fixes are validated against the grown dataset rather than against intuition.

Each turn makes the suite harder to pass and more representative. This is the single most
valuable thing an AI engineer builds, and it is almost entirely plumbing — schema, an endpoint,
a UI affordance, and a curation step. The hard part is not the code; it is the discipline and
the two traps below.

### Trap 1 — selection bias

If you only collect signal when someone clicks "this is wrong", your dataset becomes a museum
of failures and your metrics become meaningless: accuracy measured on a complaints-only dataset
is not accuracy. You need **two** collection paths:

- **Reactive** — explicit human feedback on specific runs. High value per label, heavily biased.
- **Proactive** — a random or stratified sample of ordinary runs, labelled deliberately.
  Stratify across category, action, and abstention so the sample is not dominated by whatever
  is most common. This is what keeps the dataset representative.

### Trap 2 — this project must not store ticket text

`AGENTS.md` §2 and §8 are unambiguous: do not persist raw ticket text, full prompts, or full
provider responses. `resolution_runs` stores a keyed `ticket_hash` precisely to honour that.

A naive feedback feature breaks this rule immediately — "save the ticket so we can add it to
the dataset" is the obvious implementation and it is forbidden. The constraint is a gift,
because working within it produces a better design:

- The **server** stores only the label: a `trace_id`, a structured verdict, and a bounded,
  schema-validated operator note. No ticket text, ever.
- The **browser** already holds the ticket text — the person typed it. Promotion to a dataset
  case is therefore a **client-side export**: the page assembles a candidate `golden.jsonl` row
  from the text it already has plus the run's recorded outcome, and hands it to a human.
- A human reviews that candidate, writes the expected values, and commits it to
  `data/evals/golden.jsonl` in a pull request. The dataset stays version-controlled, synthetic,
  and human-curated, which is what `AGENTS.md` requires and also what makes it trustworthy.

Say this out loud in the PR description. "We built a feedback loop that never persists customer
text, and here is the mechanism" is a far stronger answer in an interview than a feedback loop
that logs everything.

## Objective

Capture structured human judgement on production runs without persisting ticket content, and
build a reviewable path from a flagged run to a committed evaluation case.

## Decisions

- Feedback is bound to a `trace_id` and authorised by the **same signed-session ownership rule**
  already used by `GET /api/sources/:chunkId` and the refund-review confirmation endpoint. A
  session may only label its own runs. Reuse `src/auth/session.ts`; do not invent a second
  authorisation model.
- Feedback is a **structured verdict**, not free text. An enumerated verdict is gradeable; a
  paragraph is not. Allow one short, length-bounded, schema-validated note alongside it for
  human context, and treat that note as untrusted input everywhere it is displayed.
- Feedback is **append-only and idempotent per (run, session)**: re-submitting replaces the
  prior verdict, matching the idempotency discipline already established in `action_audit`.
- Dataset promotion is **human-in-the-loop by construction**. Nothing writes to
  `data/evals/golden.jsonl` automatically.
- The proactive sampling path is a local-only operator surface, behind the same non-production
  guard as `/admin/evaluations`.

## Scope

**Schema and domain**

- Add a `resolution_feedback` table via Drizzle migration: `id`, `resolution_run_id`,
  `session_hash`, `verdict`, `note` (nullable, bounded), `created_at`, with a unique constraint
  on (run, session) and the project's usual check constraints.
- Add `src/domain/feedback.ts` with the verdict enum and Zod contracts. Verdicts should be
  actionable and map onto the graders in `src/evals/graders.ts`:
  `correct`, `wrong_category`, `wrong_priority`, `wrong_action`, `unsupported_claim`,
  `bad_citation`, `should_have_abstained`, `should_not_have_abstained`.
- Add `src/db/feedback.ts` following the existing data-access pattern.

**API**

- `POST /api/resolutions/:traceId/feedback` — validate with Zod, enforce session ownership,
  upsert, return `ApiResult`. Apply the existing request guards from `src/security/http.ts`
  (`SMALL_BODY_BYTES`, origin check, `PRIVATE_NO_STORE`).
- Add route-guard tests mirroring `tests/security/route-guards.test.ts`.

**UI**

- Add a feedback control to the resolution result in `src/app/ticket-resolution-form.tsx`:
  the verdict set, an optional note, and a confirmation state. Keep it accessible and keep the
  existing styling conventions.
- Add an "export evaluation case" action that builds a candidate `golden.jsonl` line from the
  in-page ticket text plus the run's recorded classification, action, and cited source IDs, and
  copies it to the clipboard. Pre-fill the `expected` block from what the run produced and
  clearly mark it as a draft a human must correct — the whole point is that the human writes
  the expectation, not the model.

**Proactive sampling**

- Add a local-only operator view listing a stratified sample of recent runs (by category, action,
  and abstention) with their feedback state, so unlabelled runs can be worked through
  deliberately. No ticket text is available to it, by design — it shows the decision, the
  metadata, and the cited sources, which is what a labeller needs.

**Telemetry**

- A `feedback_recorded` log event and a span attribute for the verdict. Add the verdict to the
  tracing allowlist explicitly and extend the privacy-boundary tests. The note must never be
  exported to traces.

## Non-goals

- No user accounts, roles, or a reviewer queue (`AGENTS.md` §2).
- No automatic dataset writes, no automatic prompt tuning, no online learning of any kind
  (`AGENTS.md` §2 forbids the last one outright).
- No storing of ticket text, drafts, or prompts. If a design step seems to require it, the
  design is wrong — revisit it.
- No public analytics surface for feedback.

## Measurement (the deliverable)

- Demonstrate the full loop end to end in the PR description: submit a ticket, mark the result
  wrong, export the candidate case, correct its expectations by hand, commit it to
  `golden.jsonl`, and show the evaluation run that now includes it. One screenshot sequence or
  one command transcript.
- State the dataset size before and after, and note that
  `EvaluationReportSchema`'s `cases: z.array(...).min(30).max(50)` bound will need raising as
  the dataset grows — raise it in this PR if the loop pushes past it.
- Show the privacy proof: the row that was written, demonstrating it contains a hash, a verdict,
  and no ticket text.

## Documentation to update

- `README.md`: a "Feedback loop" line in "What it demonstrates", and a sentence in "Trust and
  safety boundaries" stating that feedback records a verdict and never the ticket.
- `docs/operations/` — add `feedback-and-dataset-curation.md`: the verdict taxonomy and what
  each one means, the reactive and proactive collection paths and why both exist, the
  promotion workflow step by step, and the rule that the human writes the expected values.
- `AGENTS.md` §5 (the new table and its invariants) and §6 (the new endpoint contract).

## How to review this PR

1. Grep the migration and the insert path for anything resembling ticket text. The absence is
   the feature.
2. Confirm the feedback endpoint enforces session ownership exactly as the sources endpoint
   does — an unauthenticated write path here would be a real vulnerability, not a portfolio
   detail.
3. Check that the exported candidate case is marked as a draft and that its `expected` block is
   presented as something a human must edit rather than as ground truth from the model.
4. Look for the stratified sample view. Without it, the dataset will drift toward complaints.

## Verification

```bash
pnpm verify
pnpm test:integration
pnpm test:e2e            # the journey through the new UI control
```
