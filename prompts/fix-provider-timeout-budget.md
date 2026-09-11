# Fix provider timeout budget allocation

## Diagnosis

`AI_REQUEST_TIMEOUT_MS=15000` is intended to bound one structured model-generation operation. `AnthropicLlmProvider` currently divides the remaining deadline by every configured possible attempt before passing a timeout to the Anthropic SDK. With `AI_MAX_RETRIES=2`, the initial request receives only about `5000ms`; after that artificial timeout, one timeout retry receives about another `5000ms`.

The duplicate-charge flow has already passed classification and retrieval, but resolution generation can legitimately take longer than five seconds. The observed HTTP 504 at approximately 13 seconds matches classification/retrieval overhead followed by these two prematurely shortened attempts. A previous successful end-to-end run also recorded one resolution retry and roughly ten seconds of resolution latency, confirming that the current allocation is operating near a flaky boundary.

## Proposed scope

1. Change `AnthropicLlmProvider` so each SDK attempt may use the full time remaining in the configured operation deadline instead of pre-dividing that time among hypothetical future retries.
2. Preserve the existing overall deadline, retry cap, retry-delay checks, error mapping, and the rule that timeout failures receive at most one retry. Fast transient failures may still retry within whatever deadline remains; retries must not extend the configured deadline.
3. Add deterministic provider tests proving:
   - the initial Anthropic SDK request receives the full configured remaining timeout rather than one third of it;
   - transient retries use only the remaining deadline after elapsed time and backoff;
   - a delay or exhausted deadline prevents another request;
   - timeout and safe API error mapping remain intact.
4. Do not increase `AI_REQUEST_TIMEOUT_MS` or weaken the HTTP 504 response. The existing 15-second per-generation deadline remains the operator-controlled bound.
5. Run `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test`, and `pnpm build`. Then run one local end-to-end duplicate-charge resolution and verify its cited source using the returned signed session cookie, if the configured provider is available.

## Non-goals

- Do not change retrieval, embeddings, prompts, output-token limits, model selection, API contracts, UI behavior, or database persistence.
- Do not add provider fallback, streaming, background work, or retries outside the configured deadline.
- Do not mask genuine provider timeouts; requests that consume the full deadline still return the controlled retryable `provider_timeout` response.

## Acceptance criteria

1. A fresh structured-generation attempt can use up to the configured 15-second operation deadline.
2. All retries remain bounded by the same original deadline and never extend it.
3. Deterministic tests cover initial and retry timeout budgets plus deadline exhaustion.
4. The documented duplicate-charge ticket completes end to end when Anthropic responds within the configured deadline, and cited-source authorization still succeeds.
