# Fix Claude Sonnet 5 classification compatibility

## Problem

`claude-sonnet-5` rejects classification requests because the Anthropic adapter sends `temperature: 0`. Sonnet 5 uses adaptive thinking and rejects non-default sampling parameters with HTTP 400. The adapter maps that provider bad request to `configuration_error`, producing the misleading UI message even though `.env.local` is complete and schema-valid.

## Scope

1. Keep the provider-neutral classification request's preferred temperature value unchanged.
2. Update only the Anthropic adapter translation so it omits `temperature` for `claude-sonnet-5`, where that control is unsupported, while retaining temperature zero for models that support it.
3. Add deterministic adapter regression tests proving Sonnet 5 omits the parameter and an older supported model still receives it.
4. Update local documentation with the Sonnet 5 compatibility behavior.
5. Run `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test`, and `pnpm build`.

## Out of scope

- Changing providers, prompts, schemas, routes, UI layout, retry behavior, or credentials.
- Logging raw provider responses or exposing provider details to the browser.
- Making a paid live-provider request in the automated test suite.

## Acceptance criteria

1. A classification request configured with `LLM_MODEL=claude-sonnet-5` does not include a sampling parameter rejected by that model.
2. Existing supported Anthropic models continue to receive the requested temperature setting.
3. All deterministic tests and required repository checks pass.
