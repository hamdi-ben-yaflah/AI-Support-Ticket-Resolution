import "server-only";

import type { EvidenceRetriever, RetrievedEvidence } from "@/retrieval/types";
import { isRetrievalError } from "@/retrieval/errors";
import { ToolSourceUnavailableError } from "@/investigation/errors";
import type {
  SyntheticCustomerFixture,
  SyntheticFixtureIndex,
  SyntheticInvoiceFixture,
  SyntheticServiceStatusFixture,
  SyntheticSubscriptionFixture,
} from "@/investigation/fixtures";

export interface StructuredInvestigationSources {
  getCustomer(
    customerId: string,
    signal: AbortSignal,
  ): Promise<SyntheticCustomerFixture | undefined>;
  getInvoicesByCustomer(
    customerId: string,
    signal: AbortSignal,
  ): Promise<readonly SyntheticInvoiceFixture[]>;
  getInvoicesById(
    invoiceIds: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly SyntheticInvoiceFixture[]>;
  getSubscription(
    customerId: string,
    signal: AbortSignal,
  ): Promise<SyntheticSubscriptionFixture | undefined>;
  getServiceStatus(
    serviceId: string,
    signal: AbortSignal,
  ): Promise<SyntheticServiceStatusFixture | undefined>;
}

export interface InvestigationKnowledgeSource {
  search(input: {
    query: string;
    category?: string;
    traceId: string;
    signal: AbortSignal;
  }): Promise<readonly RetrievedEvidence[]>;
}

export function createFixtureStructuredSources(
  fixtures: SyntheticFixtureIndex,
): StructuredInvestigationSources {
  return Object.freeze({
    getCustomer: async (customerId: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      return fixtures.customerById[customerId];
    },
    getInvoicesByCustomer: async (customerId: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      return fixtures.invoices
        .filter((invoice) => invoice.customerId === customerId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, 5);
    },
    getInvoicesById: async (invoiceIds: readonly string[], signal: AbortSignal) => {
      signal.throwIfAborted();
      const records = invoiceIds
        .map((invoiceId) => fixtures.invoiceById[invoiceId])
        .filter((invoice): invoice is SyntheticInvoiceFixture => invoice !== undefined)
        .sort((left, right) => left.id.localeCompare(right.id));
      return records.slice(0, 5);
    },
    getSubscription: async (customerId: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      return fixtures.subscriptionByCustomerId[customerId];
    },
    getServiceStatus: async (serviceId: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      return fixtures.serviceStatusById[serviceId];
    },
  });
}

export function createEvidenceRetrieverKnowledgeSource(
  retriever: EvidenceRetriever,
): InvestigationKnowledgeSource {
  return {
    async search(input) {
      input.signal.throwIfAborted();
      try {
        const evidence = await retriever.retrieve({
          text: input.query,
          ...(input.category ? { category: input.category } : {}),
          traceId: input.traceId,
          signal: input.signal,
        });
        input.signal.throwIfAborted();
        return evidence;
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason;
        if (isRetrievalError(error) && error.code === "insufficient_evidence") return [];
        if (isRetrievalError(error) && error.code === "unavailable") {
          throw new ToolSourceUnavailableError();
        }
        throw error;
      }
    },
  };
}
