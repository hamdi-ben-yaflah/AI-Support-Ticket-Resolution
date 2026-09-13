"use client";

import { useEffect, useId, useRef, useState } from "react";

import { createApiResultSchema, type ApiErrorCode } from "@/domain/api-result";
import {
  type Citation,
  type RefundReviewResolutionProposal,
  type ReplyResolutionProposal,
  ResolutionProposalSchema,
  type ResolutionProposal,
} from "@/domain/grounded-reply";
import {
  MockRefundReviewResultSchema,
  type MockRefundReviewResult,
} from "@/domain/refund-review";
import { SourceDetailSchema, type SourceDetail } from "@/domain/source";
import { TicketInputSchema, type TicketInput } from "@/domain/ticket";

const ResolutionResultSchema = createApiResultSchema(ResolutionProposalSchema);
const SourceResultSchema = createApiResultSchema(SourceDetailSchema);
const ConfirmationResultSchema = createApiResultSchema(
  MockRefundReviewResultSchema,
);

type SourceState =
  | { name: "loading" }
  | { name: "ready"; source: SourceDetail }
  | { name: "failure"; retryable: boolean };

type ViewState =
  | { name: "idle" }
  | { name: "processing" }
  | { name: "success"; traceId: string; proposal: ResolutionProposal }
  | { name: "failure"; traceId?: string; code?: ApiErrorCode; retryable: boolean };

type RefundActionState =
  | { name: "pending" }
  | { name: "confirming" }
  | { name: "executed"; result: MockRefundReviewResult; traceId: string }
  | { name: "rejected" }
  | {
      name: "failure";
      traceId?: string;
      code?: ApiErrorCode;
      retryable: boolean;
    };

const ERROR_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  invalid_request: "The ticket input was rejected. Check its length and customer tier.",
  provider_timeout: "The model took too long to respond. You can try this ticket again.",
  provider_unavailable: "The model service is temporarily unavailable. You can try again.",
  retrieval_unavailable: "Knowledge retrieval is temporarily unavailable. You can try again.",
  model_refused: "The model could not draft a proposal. Send it for human review.",
  model_truncated: "The model returned an incomplete proposal. Send it for human review.",
  model_output_invalid: "The model result did not pass validation. Send it for human review.",
  source_not_found: "The cited source is not available for this session.",
  source_unavailable: "The cited source is temporarily unavailable.",
  action_not_found: "This mock proposal is not available for the current session.",
  action_unavailable: "The mock action is temporarily unavailable. You can retry it.",
  configuration_error: "The resolution service is not configured. Contact an engineer.",
  internal_error: "Something unexpected prevented resolution. Contact an engineer.",
};

function validationMessage(text: string): string | undefined {
  const length = text.trim().length;
  if (length === 0) return "Enter a ticket before classifying it.";
  if (length < 10) return "Use at least 10 characters so the ticket has enough context.";
  if (length > 10_000) return "Keep the ticket at or below 10,000 characters.";
  return undefined;
}

export function TicketResolutionForm() {
  const textareaId = useId();
  const tierId = useId();
  const inFlight = useRef(false);
  const sourceRequestVersion = useRef(0);
  const sourceAbortController = useRef<AbortController | undefined>(undefined);
  const actionInFlight = useRef(false);
  const actionRequestVersion = useRef(0);
  const actionAbortController = useRef<AbortController | undefined>(undefined);
  const [text, setText] = useState("");
  const [customerTier, setCustomerTier] = useState<"" | "standard" | "premium">("");
  const [touched, setTouched] = useState(false);
  const [state, setState] = useState<ViewState>({ name: "idle" });
  const [sourceStates, setSourceStates] = useState<Record<string, SourceState>>({});
  const [refundActionState, setRefundActionState] =
    useState<RefundActionState | null>(null);

  useEffect(
    () => () => {
      sourceAbortController.current?.abort();
      actionAbortController.current?.abort();
    },
    [],
  );

  const inputError = validationMessage(text);
  const isProcessing = state.name === "processing";
  const canSubmit = !inputError && !isProcessing;

  function returnToIdle() {
    actionRequestVersion.current += 1;
    actionAbortController.current?.abort();
    actionAbortController.current = undefined;
    actionInFlight.current = false;
    setRefundActionState(null);
    if (!inFlight.current) {
      sourceRequestVersion.current += 1;
      sourceAbortController.current?.abort();
      sourceAbortController.current = undefined;
      setSourceStates({});
      setState({ name: "idle" });
    }
  }

  async function loadCitationSource(
    citation: Citation,
    version: number,
    signal: AbortSignal,
  ) {
    setSourceStates((current) => ({
      ...current,
      [citation.chunkId]: { name: "loading" },
    }));

    try {
      const response = await fetch(`/api/sources/${encodeURIComponent(citation.chunkId)}`, {
        credentials: "same-origin",
        signal,
      });
      const raw: unknown = await response.json();
      const result = SourceResultSchema.safeParse(raw);
      if (version !== sourceRequestVersion.current || signal.aborted) return;

      if (!result.success) {
        setSourceStates((current) => ({
          ...current,
          [citation.chunkId]: {
            name: "failure",
            retryable: false,
          },
        }));
        return;
      }

      if (!result.data.ok) {
        const retryable = result.data.error.retryable;
        setSourceStates((current) => ({
          ...current,
          [citation.chunkId]: { name: "failure", retryable },
        }));
        return;
      }

      const source = result.data.data;
      if (source.chunkId !== citation.chunkId) {
        setSourceStates((current) => ({
          ...current,
          [citation.chunkId]: { name: "failure", retryable: false },
        }));
        return;
      }

      setSourceStates((current) => ({
        ...current,
        [citation.chunkId]: { name: "ready", source },
      }));
    } catch {
      if (version === sourceRequestVersion.current && !signal.aborted) {
        setSourceStates((current) => ({
          ...current,
          [citation.chunkId]: { name: "failure", retryable: true },
        }));
      }
    }
  }

  function loadProposalSources(
    proposal: ReplyResolutionProposal | RefundReviewResolutionProposal,
  ) {
    sourceRequestVersion.current += 1;
    const version = sourceRequestVersion.current;
    sourceAbortController.current?.abort();
    const controller = new AbortController();
    sourceAbortController.current = controller;
    setSourceStates(
      Object.fromEntries(
        proposal.groundedReply.citations.map((citation) => [
          citation.chunkId,
          { name: "loading" } satisfies SourceState,
        ]),
      ),
    );
    for (const citation of proposal.groundedReply.citations) {
      void loadCitationSource(citation, version, controller.signal);
    }
  }

  function retrySource(citation: Citation) {
    const controller = sourceAbortController.current ?? new AbortController();
    sourceAbortController.current = controller;
    void loadCitationSource(
      citation,
      sourceRequestVersion.current,
      controller.signal,
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (inFlight.current || inputError) return;

    const candidate: TicketInput = {
      text,
      ...(customerTier ? { customerTier } : {}),
    };
    const validInput = TicketInputSchema.safeParse(candidate);
    if (!validInput.success) return;

    inFlight.current = true;
    actionRequestVersion.current += 1;
    actionAbortController.current?.abort();
    actionAbortController.current = undefined;
    actionInFlight.current = false;
    setRefundActionState(null);
    sourceRequestVersion.current += 1;
    sourceAbortController.current?.abort();
    sourceAbortController.current = undefined;
    setSourceStates({});
    setState({ name: "processing" });

    try {
      const response = await fetch("/api/tickets/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validInput.data),
      });
      const raw: unknown = await response.json();
      const result = ResolutionResultSchema.safeParse(raw);

      if (!result.success) {
        setState({ name: "failure", retryable: false });
      } else if (!result.data.ok) {
        setState({
          name: "failure",
          traceId: result.data.traceId,
          code: result.data.error.code,
          retryable: result.data.error.retryable,
        });
      } else {
        setState({
          name: "success",
          traceId: result.data.traceId,
          proposal: result.data.data,
        });
        if (result.data.data.action !== "needs_human_review") {
          loadProposalSources(result.data.data);
          setRefundActionState(
            result.data.data.action === "request_refund_review"
              ? { name: "pending" }
              : null,
          );
        } else {
          sourceRequestVersion.current += 1;
          sourceAbortController.current = undefined;
          setSourceStates({});
        }
      }
    } catch {
      setState({ name: "failure", retryable: true });
    } finally {
      inFlight.current = false;
    }
  }

  async function confirmRefundReview(
    proposal: RefundReviewResolutionProposal,
  ) {
    if (
      actionInFlight.current ||
      refundActionState?.name === "rejected" ||
      (refundActionState?.name === "failure" &&
        !refundActionState.retryable)
    ) {
      return;
    }

    actionInFlight.current = true;
    actionRequestVersion.current += 1;
    const version = actionRequestVersion.current;
    actionAbortController.current?.abort();
    const controller = new AbortController();
    actionAbortController.current = controller;
    setRefundActionState({ name: "confirming" });

    try {
      const response = await fetch(
        `/api/actions/refund-review/${encodeURIComponent(proposal.actionProposal.proposalId)}/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ confirmed: true }),
          signal: controller.signal,
        },
      );
      const raw: unknown = await response.json();
      if (version !== actionRequestVersion.current || controller.signal.aborted) {
        return;
      }
      const result = ConfirmationResultSchema.safeParse(raw);
      if (!result.success) {
        setRefundActionState({ name: "failure", retryable: false });
      } else if (!result.data.ok) {
        setRefundActionState({
          name: "failure",
          traceId: result.data.traceId,
          code: result.data.error.code,
          retryable: result.data.error.retryable,
        });
      } else if (
        result.data.data.proposalId !== proposal.actionProposal.proposalId
      ) {
        setRefundActionState({ name: "failure", retryable: false });
      } else {
        setRefundActionState({
          name: "executed",
          result: result.data.data,
          traceId: result.data.traceId,
        });
      }
    } catch {
      if (version === actionRequestVersion.current && !controller.signal.aborted) {
        setRefundActionState({ name: "failure", retryable: true });
      }
    } finally {
      if (version === actionRequestVersion.current) {
        actionInFlight.current = false;
      }
    }
  }

  function rejectRefundReview() {
    if (actionInFlight.current) return;
    actionRequestVersion.current += 1;
    actionAbortController.current?.abort();
    actionAbortController.current = undefined;
    setRefundActionState({ name: "rejected" });
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#7a6552]">New analysis</p>
        <h2 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-[#17201d]">
          Resolve a support ticket
        </h2>
        <p className="mt-2 text-sm leading-6 text-[#65706c]">
          Synthetic data only. Anthropic classifies and recommends; Voyage AI is used
          only for knowledge retrieval embeddings.
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <div>
          <div className="flex items-end justify-between gap-4">
            <label htmlFor={textareaId} className="text-sm font-semibold text-[#26312d]">
              Ticket text <span className="text-[#b43c32]">*</span>
            </label>
            <span
              id={`${textareaId}-count`}
              className={`text-xs tabular-nums ${text.length > 10_000 ? "text-[#b43c32]" : "text-[#7a8580]"}`}
            >
              {text.length.toLocaleString()} / 10,000
            </span>
          </div>
          <textarea
            id={textareaId}
            value={text}
            onBlur={() => setTouched(true)}
            onChange={(event) => {
              setText(event.target.value);
              returnToIdle();
            }}
            aria-invalid={touched && Boolean(inputError)}
            aria-describedby={`${textareaId}-help ${textareaId}-count${touched && inputError ? ` ${textareaId}-error` : ""}`}
            placeholder="Paste the customer’s issue here…"
            rows={9}
            className="mt-2 w-full resize-y rounded-2xl border border-[#cbcfc9] bg-white px-4 py-4 text-[15px] leading-6 text-[#17201d] shadow-[inset_0_1px_1px_rgba(23,32,29,0.03)] outline-none transition placeholder:text-[#9ba39f] focus:border-[#2d6b5c] focus:ring-4 focus:ring-[#2d6b5c]/10 aria-invalid:border-[#c5574e] aria-invalid:focus:ring-[#c5574e]/10"
          />
          <div className="mt-2 min-h-5">
            {touched && inputError ? (
              <p id={`${textareaId}-error`} role="alert" className="text-xs font-medium text-[#a63b33]">
                {inputError}
              </p>
            ) : (
              <p id={`${textareaId}-help`} className="text-xs text-[#7a8580]">
                10–10,000 characters. Do not paste real customer data.
              </p>
            )}
          </div>
        </div>
        <div className="mt-6">
          <label htmlFor={tierId} className="text-sm font-semibold text-[#26312d]">
            Customer tier <span className="font-normal text-[#7a8580]">(optional)</span>
          </label>
          <select
            id={tierId}
            value={customerTier}
            onChange={(event) => {
              setCustomerTier(event.target.value as "" | "standard" | "premium");
              returnToIdle();
            }}
            className="mt-2 h-12 w-full appearance-none rounded-xl border border-[#cbcfc9] bg-white px-4 text-sm text-[#26312d] outline-none transition focus:border-[#2d6b5c] focus:ring-4 focus:ring-[#2d6b5c]/10"
          >
            <option value="">Not specified</option>
            <option value="standard">Standard</option>
            <option value="premium">Premium</option>
          </select>
        </div>

        <div className="mt-7 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs leading-5 text-[#7a8580]">No reply or customer action will be sent.</p>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#e8ca62] px-6 text-sm font-bold text-[#19372f] shadow-[0_8px_22px_rgba(145,113,24,0.18)] transition hover:bg-[#f0d470] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[#173f36] disabled:cursor-not-allowed disabled:bg-[#e3e1d8] disabled:text-[#939893] disabled:shadow-none"
          >
            {isProcessing ? (
              <>
                <span
                  className="size-4 animate-spin rounded-full border-2 border-[#19372f]/25 border-t-[#19372f]"
                  aria-hidden="true"
                />
                Resolving…
              </>
            ) : state.name === "failure" && state.retryable ? (
              "Try resolution again"
            ) : (
              "Resolve ticket"
            )}
          </button>
        </div>
      </form>

      <div className="mt-8 border-t border-[#deddd5] pt-8" aria-live="polite">
        {state.name === "idle" && (
          <div className="rounded-2xl border border-dashed border-[#c8ccc6] bg-[#f7f6f1] px-5 py-6">
            <p className="text-sm font-semibold text-[#53605b]">Awaiting a ticket</p>
            <p className="mt-1 text-sm text-[#7a8580]">
              A validated, knowledge-grounded proposal will appear here.
            </p>
          </div>
        )}

        {state.name === "processing" && (
          <div role="status" className="rounded-2xl border border-[#c7d8d2] bg-[#eef5f2] px-5 py-6">
            <p className="text-sm font-semibold text-[#254f44]">Resolving the ticket…</p>
            <p className="mt-1 text-sm text-[#5f746d]">
              The result will be validated before it is shown.
            </p>
          </div>
        )}

        {state.name === "failure" && (
          <div role="alert" className="rounded-2xl border border-[#e2b9b4] bg-[#fff4f2] px-5 py-5">
            <p className="text-sm font-semibold text-[#8f312b]">Resolution not available</p>
            <p className="mt-1 text-sm leading-6 text-[#854d48]">
              {state.code
                ? ERROR_MESSAGES[state.code] ?? ERROR_MESSAGES.internal_error
                : "The response could not be verified. Check your connection and try again."}
            </p>
            {state.traceId && (
              <p className="mt-3 font-mono text-[11px] text-[#986c67]">Trace {state.traceId}</p>
            )}
          </div>
        )}

        {state.name === "success" &&
          state.proposal.action === "needs_human_review" && (
          <section
            role="alert"
            className="overflow-hidden rounded-2xl border border-[#deb86e] bg-[#fffaf0] shadow-[0_14px_32px_rgba(87,64,28,0.08)]"
          >
            <div className="flex flex-col gap-3 border-b border-[#ead7ae] bg-[#fff2d2] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.13em] text-[#8a651f]">
                  Insufficient evidence warning
                </p>
                <h3 className="mt-1 text-base font-semibold text-[#5f4212]">
                  Human review required
                </h3>
              </div>
              <span className="w-fit rounded-full border border-[#dfc27f] bg-white px-3 py-1 text-xs font-semibold text-[#76561d]">
                {Math.round(state.proposal.confidence * 100)}% confidence signal
              </span>
            </div>
            <div className="grid grid-cols-2 gap-px bg-[#ead7ae]">
              <ResultField label="Category" value={state.proposal.category} />
              <ResultField label="Priority" value={state.proposal.priority} />
            </div>
            <div className="px-5 py-5 sm:px-6">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#887047]">
                Summary
              </p>
              <p className="mt-2 text-[15px] leading-6 text-[#3e3423]">
                {state.proposal.summary}
              </p>
              <div className="mt-5 rounded-xl border border-[#e1c98f] bg-white px-4 py-4">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#806021]">
                  Why review is needed
                </p>
                <p className="mt-2 text-sm leading-6 text-[#5c4a2b]">
                  {state.proposal.reason}
                </p>
              </div>
              <div className="mt-5 rounded-xl bg-[#5f4212] px-4 py-4 text-[#fff8e8]">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#f0d89e]">
                  Recommended next action
                </p>
                <p className="mt-2 text-sm leading-6">
                  Review the ticket and supporting policy manually. No proposed reply or
                  customer action was produced.
                </p>
              </div>
              <p className="mt-5 border-t border-[#eadfc8] pt-4 font-mono text-[11px] text-[#8b7958]">
                Trace {state.traceId}
              </p>
            </div>
          </section>
        )}

        {state.name === "success" &&
          state.proposal.action !== "needs_human_review" && (
          <section className="overflow-hidden rounded-2xl border border-[#bfcfc9] bg-white shadow-[0_14px_32px_rgba(43,63,56,0.07)]">
            <div className="flex flex-col gap-3 border-b border-[#e1e5e1] bg-[#f0f6f3] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.13em] text-[#56736a]">
                  AI-generated proposal
                </p>
                <h3 className="mt-1 text-base font-semibold text-[#213b33]">
                  {state.proposal.action === "request_refund_review"
                    ? "Mock review proposal ready"
                    : "Supported draft ready"}
                </h3>
              </div>
              <span className="w-fit rounded-full border border-[#c5d8d1] bg-white px-3 py-1 text-xs font-semibold text-[#356152]">
                {Math.round(state.proposal.confidence * 100)}% confidence signal
              </span>
            </div>
            <div className="grid grid-cols-2 gap-px bg-[#e1e5e1]">
              <ResultField label="Category" value={state.proposal.category} />
              <ResultField label="Priority" value={state.proposal.priority} />
            </div>
            <div className="px-5 py-5 sm:px-6">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a8580]">Summary</p>
              <p className="mt-2 text-[15px] leading-6 text-[#26312d]">{state.proposal.summary}</p>
              <div className="mt-4 rounded-xl border border-[#e1e5e1] bg-[#f7f9f7] px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#6f7d77]">
                  Why a draft is supported
                </p>
                <p className="mt-1.5 text-sm leading-6 text-[#5f6f69]">
                  {state.proposal.reason}
                </p>
              </div>
              <div className="mt-6 rounded-2xl border border-[#d8ded9] bg-[#fafbf9] p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#526d64]">
                    Proposed reply
                  </p>
                  <span className="rounded-full bg-[#f6e9b6] px-2.5 py-1 text-[11px] font-semibold text-[#725b18]">
                    Draft · not sent
                  </span>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-[15px] leading-7 text-[#26312d]">
                  {state.proposal.groundedReply.suggestedResponse}
                </p>
                {state.proposal.action === "request_refund_review" && (
                  <RefundReviewControls
                    proposal={state.proposal}
                    actionState={refundActionState ?? { name: "pending" }}
                    onConfirm={() => {
                      if (
                        state.name === "success" &&
                        state.proposal.action === "request_refund_review"
                      ) {
                        void confirmRefundReview(state.proposal);
                      }
                    }}
                    onReject={rejectRefundReview}
                  />
                )}
                <div className="mt-5 border-t border-[#e3e7e3] pt-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a8580]">
                    Knowledge citations
                  </p>
                  <ul className="mt-3 space-y-2">
                    {state.proposal.groundedReply.citations.map((citation) => {
                      const sourceState = sourceStates[citation.chunkId];
                      return (
                        <li
                          key={citation.chunkId}
                          className="rounded-xl border border-[#d9e1dc] bg-white px-4 py-4 text-xs leading-5 text-[#52605b]"
                        >
                          {sourceState?.name === "ready" ? (
                            <>
                              <p className="font-semibold text-[#284f43]">
                                {sourceState.source.title}
                              </p>
                              <p className="mt-0.5 text-[#708079]">
                                {sourceState.source.sourceId}
                                <span aria-hidden="true"> · </span>
                                {sourceState.source.section}
                              </p>
                              <div className="mt-3 rounded-lg border border-[#dbe5df] bg-[#f3f7f4] px-3 py-3">
                                <p className="font-semibold uppercase tracking-[0.1em] text-[#56736a]">
                                  Retrieved evidence
                                </p>
                                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-[#30463f]">
                                  {sourceState.source.content}
                                </p>
                              </div>
                            </>
                          ) : sourceState?.name === "failure" ? (
                            <div role="alert" className="rounded-lg bg-[#fff4f2] px-3 py-3 text-[#854d48]">
                              <p>The exact source could not be loaded.</p>
                              {sourceState.retryable && (
                                <button
                                  type="button"
                                  onClick={() => retrySource(citation)}
                                  className="mt-2 rounded-md border border-[#d5aaa5] bg-white px-3 py-1.5 font-semibold text-[#8f312b] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8f312b]"
                                >
                                  Retry source
                                </button>
                              )}
                            </div>
                          ) : (
                            <p role="status" className="text-[#66746f]">
                              Loading exact source…
                            </p>
                          )}
                          <div className="mt-3 border-t border-[#e5e8e5] pt-3">
                            <p className="font-semibold uppercase tracking-[0.1em] text-[#7a8580]">
                              Generated support claim
                            </p>
                            <p className="mt-1 text-[#626f6a]">{citation.claim}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
              <p className="mt-5 border-t border-[#eceeea] pt-4 font-mono text-[11px] text-[#87908c]">
                Trace {state.traceId}
              </p>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function RefundReviewControls({
  proposal,
  actionState,
  onConfirm,
  onReject,
}: {
  proposal: RefundReviewResolutionProposal;
  actionState: RefundActionState;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const arguments_ = proposal.actionProposal.arguments;
  const canConfirm =
    actionState.name === "pending" ||
    actionState.name === "executed" ||
    (actionState.name === "failure" && actionState.retryable);

  return (
    <div className="mt-5 rounded-xl border border-[#dfc989] bg-[#fffaf0] px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#806021]">
            Proposed mock action
          </p>
          <p className="mt-1 font-mono text-xs font-semibold text-[#5f4212]">
            {proposal.actionProposal.toolName}
          </p>
        </div>
        <span className="rounded-full border border-[#dfc27f] bg-white px-2.5 py-1 text-[11px] font-semibold text-[#76561d]">
          {actionState.name === "executed"
            ? "executed · local mock only"
            : actionState.name === "rejected"
              ? "rejected · not executed"
              : proposal.actionProposal.state}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-[#5c4a2b]">
        Confirmation creates only a local audit result. It does not approve or
        issue a refund, change a payment, or contact a customer.
      </p>
      <dl className="mt-4 space-y-3 rounded-lg border border-[#ead7ae] bg-white px-4 py-4 text-sm">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-[#887047]">
            Reason
          </dt>
          <dd className="mt-1 leading-6 text-[#3e3423]">{arguments_.reason}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-[#887047]">
            Ticket summary
          </dt>
          <dd className="mt-1 leading-6 text-[#3e3423]">
            {arguments_.ticketSummary}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-[#887047]">
            Evidence chunk IDs
          </dt>
          <dd className="mt-1 space-y-1 font-mono text-[11px] text-[#5c4a2b]">
            {arguments_.evidenceChunkIds.map((id) => (
              <span key={id} className="block break-all">
                {id}
              </span>
            ))}
          </dd>
        </div>
      </dl>
      <p className="mt-3 break-all font-mono text-[11px] text-[#8b7958]">
        Proposal {proposal.actionProposal.proposalId}
      </p>

      {actionState.name === "executed" && (
        <div role="status" className="mt-4 rounded-lg bg-[#e9f5ef] px-4 py-3 text-sm text-[#245343]">
          <p className="font-semibold">Local mock review recorded</p>
          <p className="mt-1 leading-6">{actionState.result.message}</p>
          <p className="mt-2 font-mono text-[11px]">
            Executed {actionState.result.executedAt} · Trace {actionState.traceId}
          </p>
        </div>
      )}
      {actionState.name === "rejected" && (
        <div role="status" className="mt-4 rounded-lg bg-[#f2f1ec] px-4 py-3 text-sm text-[#53605b]">
          Proposal rejected locally. No confirmation request was sent and no mock
          action was executed.
        </div>
      )}
      {actionState.name === "failure" && (
        <div role="alert" className="mt-4 rounded-lg bg-[#fff0ed] px-4 py-3 text-sm text-[#854d48]">
          <p className="font-semibold">Mock action not recorded</p>
          <p className="mt-1 leading-6">
            {actionState.code
              ? ERROR_MESSAGES[actionState.code] ?? ERROR_MESSAGES.internal_error
              : "The confirmation response could not be verified."}
          </p>
          {actionState.traceId && (
            <p className="mt-2 font-mono text-[11px]">
              Trace {actionState.traceId}
            </p>
          )}
        </div>
      )}

      {actionState.name !== "rejected" && (
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {actionState.name === "pending" && (
            <button
              type="button"
              onClick={onReject}
              className="min-h-11 rounded-lg border border-[#c9b67c] bg-white px-4 text-sm font-semibold text-[#67501c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#67501c]"
            >
              Reject proposal
            </button>
          )}
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#5f4212] px-4 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5f4212] disabled:cursor-not-allowed disabled:bg-[#aaa18d]"
          >
            {actionState.name === "confirming" ? (
              <>
                <span
                  className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
                  aria-hidden="true"
                />
                Recording mock review…
              </>
            ) : actionState.name === "executed" ? (
              "Confirm again (idempotent)"
            ) : actionState.name === "failure" && actionState.retryable ? (
              "Retry mock confirmation"
            ) : (
              "Confirm mock review"
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function ResultField({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-5 py-4 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a8580]">{label}</p>
      <p className="mt-1.5 text-base font-semibold capitalize text-[#26312d]">{value}</p>
    </div>
  );
}
