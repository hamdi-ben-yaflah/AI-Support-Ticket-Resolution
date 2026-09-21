import "server-only";

import { LlmError } from "@/ai/errors";
import type { GenerateResult, LlmProvider } from "@/ai/types";
import type { ResolutionExecution } from "@/domain/resolution-run";
import { CitationJudgeOutputSchema, type CitationJudgeOutput } from "@/evals/contracts";
import {
  buildCitationJudgeInput,
  CITATION_JUDGE_PROMPT_VERSION,
  CITATION_JUDGE_SYSTEM_PROMPT,
} from "@/evals/prompts/citation-judge.v1";

export async function judgeCitations(input: {
  execution: ResolutionExecution;
  provider: LlmProvider;
  traceId: string;
}): Promise<GenerateResult<CitationJudgeOutput> | null> {
  if (input.execution.proposal.action === "needs_human_review") return null;

  const expectedIds = input.execution.proposal.groundedReply.citations.map(
    (citation) => citation.chunkId,
  );
  const generated = await input.provider.generateStructured({
    task: "evaluation",
    system: CITATION_JUDGE_SYSTEM_PROMPT,
    input: buildCitationJudgeInput(input.execution),
    outputSchema: CitationJudgeOutputSchema,
    maxOutputTokens: 800,
    temperature: 0,
    cacheableSystemPrompt: true,
    metadata: {
      traceId: input.traceId,
      promptVersion: CITATION_JUDGE_PROMPT_VERSION,
    },
  });

  const actualIds = generated.value.decisions.map((decision) => decision.citationId);
  if (
    new Set(actualIds).size !== actualIds.length ||
    actualIds.length !== expectedIds.length ||
    actualIds.some((id) => !expectedIds.includes(id)) ||
    expectedIds.some((id) => !actualIds.includes(id))
  ) {
    throw new LlmError("invalid_output", "Citation judge IDs do not match citations.", {
      retryable: false,
      retryCount: generated.retryCount,
      finishReason: generated.finishReason,
    });
  }

  return generated;
}
