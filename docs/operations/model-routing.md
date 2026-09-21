# Static model bindings

The application uses one Anthropic provider with three explicit task bindings:

| Task             | Environment variable       | Purpose                                        |
| ---------------- | -------------------------- | ---------------------------------------------- |
| Classification   | `LLM_MODEL_CLASSIFICATION` | Category, priority, and ticket summary         |
| Resolution       | `LLM_MODEL_RESOLUTION`     | Evidence-grounded response and action proposal |
| Evaluation judge | `LLM_MODEL_JUDGE`          | Citation and answer grading during evaluations |

Each empty task override falls back to `LLM_MODEL`. Bindings are resolved at process configuration time and recorded on resolution and evaluation runs. The application does not route based on ticket content, confidence, latency, cost, or provider errors, and it does not fall back to another model after a failed request. Provider retries are bounded within the configured request deadline and preserve the same model.

## Rollout

1. Run the deterministic replay suite before changing bindings: `pnpm eval:replay -- --concurrency=3`.
2. Record a new, explicitly versioned evaluation with the proposed bindings: `pnpm eval:record -- --concurrency=3`.
3. Compare the candidate against a compatible baseline. Review schema validity, category accuracy, abstention rate, citation grading, latency, retries, token usage, and errors. Treat a changed judge model as a re-baseline event because judge scores are not directly comparable across judge models.
4. Promote only after the candidate meets the configured quality thresholds and the measured cost is acceptable. Keep `LLM_MODEL` set to the last known-good model so clearing task overrides is a quick rollback.

Mixed-model cost is reported only when reviewed pricing is configured for the measured setup. If pricing is unavailable, the report leaves estimated cost unset rather than guessing. Live provider credentials and evaluation budgets are required for `eval:record`; replay remains credential-free.

## Rollback

Clear the task-specific overrides (or set them back to the known-good model), restart the application, and run replay plus the evaluation comparison again. Existing resolution metadata remains immutable and records the bindings used at execution time.
