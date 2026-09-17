import "server-only";

import { z } from "zod";

import {
  GetCustomerProfileArgumentsSchema,
  GetCustomerProfileResultSchema,
  GetInvoicesArgumentsSchema,
  GetInvoicesResultSchema,
  GetServiceStatusArgumentsSchema,
  GetServiceStatusResultSchema,
  GetSubscriptionArgumentsSchema,
  GetSubscriptionResultSchema,
  INVESTIGATION_TOOL_NAMES,
  SearchKnowledgeArgumentsSchema,
  SearchKnowledgeResultSchema,
  TOOL_CATALOG_VERSION,
  TOOL_SCHEMA_VERSION,
  ToolCatalogDescriptorSchema,
  type InvestigationToolName,
  type InvestigationToolPurpose,
} from "@/domain/investigation-tools";
import { isToolSourceUnavailableError } from "@/investigation/errors";
import type {
  SyntheticCustomerFixture,
  SyntheticInvoiceFixture,
  SyntheticServiceStatusFixture,
  SyntheticSubscriptionFixture,
} from "@/investigation/fixtures";
import type {
  InvestigationKnowledgeSource,
  StructuredInvestigationSources,
} from "@/investigation/sources";

export type ToolHandlerContext = Readonly<{
  traceId: string;
  signal: AbortSignal;
}>;

export type InvestigationToolCatalogEntry = Readonly<{
  name: InvestigationToolName;
  purpose: InvestigationToolPurpose;
  argumentsSchema: z.ZodType;
  resultSchema: z.ZodType;
  handler: (rawArguments: unknown, context: ToolHandlerContext) => Promise<unknown>;
}>;

export type InvestigationToolCatalog = Readonly<{
  version: typeof TOOL_CATALOG_VERSION;
  schemaVersion: typeof TOOL_SCHEMA_VERSION;
  entries: Readonly<Record<InvestigationToolName, InvestigationToolCatalogEntry>>;
}>;

function unavailable(toolName: InvestigationToolName) {
  return {
    schemaVersion: TOOL_SCHEMA_VERSION,
    toolName,
    status: "unavailable" as const,
    evidence: [],
  };
}

function mapCustomer(record: SyntheticCustomerFixture) {
  return {
    evidenceKey: `customer:${record.id}`,
    sourceType: "customer_profile" as const,
    customerId: record.id,
    tier: record.tier,
    accountState: record.accountState,
  };
}

function mapInvoice(record: SyntheticInvoiceFixture) {
  return {
    evidenceKey: `invoice:${record.id}`,
    sourceType: "invoice" as const,
    invoiceId: record.id,
    customerId: record.customerId,
    status: record.status,
    amountMinor: record.amountMinor,
    currency: record.currency,
    planCode: record.planCode,
    billingPeriodStart: record.billingPeriodStart,
    billingPeriodEnd: record.billingPeriodEnd,
    chargedAt: record.chargedAt,
  };
}

function mapSubscription(record: SyntheticSubscriptionFixture) {
  return {
    evidenceKey: `subscription:${record.id}`,
    sourceType: "subscription" as const,
    subscriptionId: record.id,
    customerId: record.customerId,
    state: record.state,
    planCode: record.planCode,
    renewalDate: record.renewalDate,
    pendingPlanCode: record.pendingPlanCode,
    pendingChangeDate: record.pendingChangeDate,
  };
}

function mapServiceStatus(record: SyntheticServiceStatusFixture) {
  return {
    evidenceKey: `service:${record.id}`,
    sourceType: "service_status" as const,
    serviceId: record.id,
    label: record.label,
    state: record.state,
    checkedAt: record.checkedAt,
    activeIncident: record.activeIncident
      ? {
          incidentId: record.activeIncident.id,
          title: record.activeIncident.title,
          summary: record.activeIncident.summary,
          state: record.activeIncident.state,
          startedAt: record.activeIncident.startedAt,
        }
      : null,
  };
}

function boundedText(value: string, maximumLength: number): string {
  return value.trim().slice(0, maximumLength);
}

export function createInvestigationToolCatalog(input: {
  structuredSources: StructuredInvestigationSources;
  knowledgeSource: InvestigationKnowledgeSource;
}): InvestigationToolCatalog {
  const entries: Record<InvestigationToolName, InvestigationToolCatalogEntry> = {
    searchKnowledge: {
      name: "searchKnowledge",
      purpose: "search_policy_or_guidance",
      argumentsSchema: SearchKnowledgeArgumentsSchema,
      resultSchema: SearchKnowledgeResultSchema,
      async handler(rawArguments, context) {
        const args = SearchKnowledgeArgumentsSchema.parse(rawArguments);
        try {
          const records = (
            await input.knowledgeSource.search({
              query: args.query,
              ...(args.category ? { category: args.category } : {}),
              traceId: context.traceId,
              signal: context.signal,
            })
          ).slice(0, 5);
          return {
            schemaVersion: TOOL_SCHEMA_VERSION,
            toolName: "searchKnowledge",
            status: records.length === 0 ? "not_found" : "succeeded",
            evidence: records.map((record) => ({
              evidenceKey: `knowledge:${record.chunkId}`,
              sourceType: "knowledge" as const,
              title: boundedText(record.title, 200),
              section: boundedText(record.section, 300),
              excerpt: boundedText(record.content, 2_500),
              score: record.similarity,
            })),
          };
        } catch (error) {
          if (isToolSourceUnavailableError(error)) return unavailable("searchKnowledge");
          throw error;
        }
      },
    },
    getCustomerProfile: {
      name: "getCustomerProfile",
      purpose: "verify_customer",
      argumentsSchema: GetCustomerProfileArgumentsSchema,
      resultSchema: GetCustomerProfileResultSchema,
      async handler(rawArguments, context) {
        const args = GetCustomerProfileArgumentsSchema.parse(rawArguments);
        try {
          const record = await input.structuredSources.getCustomer(args.customerId, context.signal);
          return {
            schemaVersion: TOOL_SCHEMA_VERSION,
            toolName: "getCustomerProfile",
            status: record ? "succeeded" : "not_found",
            evidence: record ? [mapCustomer(record)] : [],
          };
        } catch (error) {
          if (isToolSourceUnavailableError(error)) return unavailable("getCustomerProfile");
          throw error;
        }
      },
    },
    getInvoices: {
      name: "getInvoices",
      purpose: "verify_invoice_records",
      argumentsSchema: GetInvoicesArgumentsSchema,
      resultSchema: GetInvoicesResultSchema,
      async handler(rawArguments, context) {
        const args = GetInvoicesArgumentsSchema.parse(rawArguments);
        try {
          const records =
            "customerId" in args
              ? await input.structuredSources.getInvoicesByCustomer(args.customerId, context.signal)
              : await input.structuredSources.getInvoicesById(args.invoiceIds, context.signal);
          const bounded = records.slice(0, 5);
          return {
            schemaVersion: TOOL_SCHEMA_VERSION,
            toolName: "getInvoices",
            status: bounded.length === 0 ? "not_found" : "succeeded",
            evidence: bounded.map(mapInvoice),
          };
        } catch (error) {
          if (isToolSourceUnavailableError(error)) return unavailable("getInvoices");
          throw error;
        }
      },
    },
    getSubscription: {
      name: "getSubscription",
      purpose: "verify_subscription_state",
      argumentsSchema: GetSubscriptionArgumentsSchema,
      resultSchema: GetSubscriptionResultSchema,
      async handler(rawArguments, context) {
        const args = GetSubscriptionArgumentsSchema.parse(rawArguments);
        try {
          const record = await input.structuredSources.getSubscription(
            args.customerId,
            context.signal,
          );
          return {
            schemaVersion: TOOL_SCHEMA_VERSION,
            toolName: "getSubscription",
            status: record ? "succeeded" : "not_found",
            evidence: record ? [mapSubscription(record)] : [],
          };
        } catch (error) {
          if (isToolSourceUnavailableError(error)) return unavailable("getSubscription");
          throw error;
        }
      },
    },
    getServiceStatus: {
      name: "getServiceStatus",
      purpose: "check_service_health",
      argumentsSchema: GetServiceStatusArgumentsSchema,
      resultSchema: GetServiceStatusResultSchema,
      async handler(rawArguments, context) {
        const args = GetServiceStatusArgumentsSchema.parse(rawArguments);
        try {
          const record = await input.structuredSources.getServiceStatus(
            args.serviceId,
            context.signal,
          );
          return {
            schemaVersion: TOOL_SCHEMA_VERSION,
            toolName: "getServiceStatus",
            status: record ? "succeeded" : "not_found",
            evidence: record ? [mapServiceStatus(record)] : [],
          };
        } catch (error) {
          if (isToolSourceUnavailableError(error)) return unavailable("getServiceStatus");
          throw error;
        }
      },
    },
  };

  const actualNames = Object.keys(entries).sort();
  const expectedNames = [...INVESTIGATION_TOOL_NAMES].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Investigation tool catalog is incomplete.");
  }

  return Object.freeze({
    version: TOOL_CATALOG_VERSION,
    schemaVersion: TOOL_SCHEMA_VERSION,
    entries: Object.freeze(entries),
  });
}

export function describeInvestigationToolCatalog(catalog: InvestigationToolCatalog) {
  return ToolCatalogDescriptorSchema.parse({
    version: catalog.version,
    schemaVersion: catalog.schemaVersion,
    tools: INVESTIGATION_TOOL_NAMES.map((name) => ({
      name,
      purpose: catalog.entries[name].purpose,
    })),
  });
}
