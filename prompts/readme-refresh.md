# README refresh plan

## Goal

Rewrite `README.md` so a technical or non-technical reader can quickly understand the product, see why it is trustworthy, run it locally, and inspect the engineering depth without reading an operations dossier.

## Scope

- Replace the opening with a concise product pitch and a short list of standout capabilities.
- Link prominently to the production demo at https://ai-support-ticket-resolution.sidratsoft.me/.
- Add a GitHub-rendered Mermaid flow covering ticket submission, classification, retrieval, grounded response, abstention, and the separately confirmed mock refund-review path.
- Restructure the README around: what it does, trust/safety boundaries, architecture, quick start, evaluation, commands, and deployment/operations links.
- Keep claims aligned with the implemented code and current synthetic/local-only constraints.
- Retain useful setup commands, evaluation commands, provider choices, security guarantees, and links to deeper operational documentation.
- Remove or compress the dated live-evaluation postmortem and the 25-step manual verification list; point readers to the relevant test/operations commands instead.

## Acceptance criteria

- A new reader can identify the product and its boundaries within the first screen.
- The diagram is readable in GitHub Markdown and accurately represents the implemented flow.
- Quick start is copyable and does not imply that real customer, payment, or help-desk systems are connected.
- The README remains technically credible: it mentions schema validation, pgvector retrieval, citations, abstention, idempotent mock actions, evaluation, observability, and the V2 investigation foundation without overclaiming production autonomy.
- No application code, dependencies, or behavior change.

## Verification

- Inspect the rendered Markdown structure locally with `sed`/`rg`.
- Run `pnpm format:check` after the README update.
