# Fix duplicate-ticket retrieval threshold

## Diagnosis

The documented manual ticket `I upgraded yesterday, but I was charged for both plans.` embeds successfully with the configured Voyage `voyage-4` model and retrieves the intended `duplicate-charges` / `Plan upgrades` chunk first at cosine similarity `0.6605782700274324`.

The active and default `RETRIEVAL_MINIMUM_SIMILARITY` is `0.68`, so the retriever discards that relevant chunk and returns the controlled `insufficient_evidence` response. The next candidates score `0.5443614340367072` and `0.5066161012604348`, leaving a meaningful separation below the intended match.

## Approved scope

1. Lower the retrieval minimum-similarity default and `.env.example` value from `0.68` to `0.65`.
2. Align the two threshold references in `docs/ai-support-copilot-technical-spec.md` with `0.65`.
3. Update only `RETRIEVAL_MINIMUM_SIMILARITY` in the ignored local `.env.local` so the user's running development server uses the corrected setting after restart; do not inspect, expose, or change any secret values.
4. Add deterministic configuration/retrieval regression coverage proving that a relevant candidate at the reproduced `0.6605782700274324` score is retained by the default threshold while candidates below `0.65` remain excluded.
5. Re-run lint, strict type-checking, unit tests, the production build, and a live retrieval diagnostic for the documented ticket. If the live text-generation credentials are usable, run one end-to-end local resolve request and verify that its cited-source request succeeds with the returned signed cookie.

## Non-goals

- Do not change embeddings, distance metrics, chunking, prompts, ranking, fallback behavior, knowledge content, or provider configuration.
- Do not weaken the controlled abstention path for tickets whose best evidence remains below `0.65`.
- Do not modify any API or UI contract beyond the already approved source-inspection work.

## Acceptance criteria

1. The documented duplicate-plan-charge ticket retains its intended top chunk instead of abstaining at retrieval.
2. The committed default, environment example, local development setting, and technical specification agree on `0.65`.
3. Candidates below `0.65` are still rejected and insufficient-evidence behavior remains covered.
4. Verification results and any live-provider limitation are reported exactly.
