# Remove the live-evaluation schedule

## Objective

Make the live AI evaluation workflow manual-only so it never incurs provider cost on a schedule.

## Changes

1. Remove the `schedule` trigger from `.github/workflows/ai-evaluation.yml` while preserving
   `workflow_dispatch` and the protected `ai-evaluation` environment.
2. Update the README and evaluation-gating operations guide so they describe live evaluation as
   manually dispatched only.
3. Validate formatting, inspect the workflow diff, commit, and push to the active PR branch.

## Acceptance criteria

- `Live AI evaluation` has only a `workflow_dispatch` trigger.
- Replay evaluation remains the pull-request gate.
- Cassette recording remains a separate manual workflow.
- Documentation does not claim live evaluation runs nightly.

