import { z } from "zod";

import { CATEGORIES } from "@/domain/classification";

export const TOOL_CATALOG_VERSION = "tool-catalog.v1" as const;
export const TOOL_SCHEMA_VERSION = "tool-schema.v1" as const;
export const SYNTHETIC_SOURCES_VERSION = "synthetic-sources.v1" as const;

export const INVESTIGATION_TOOL_NAMES = [
  "searchKnowledge",
  "getCustomerProfile",
  "getInvoices",
  "getSubscription",
  "getServiceStatus",
] as const;

export const INVESTIGATION_TOOL_PURPOSES = [
  "search_policy_or_guidance",
  "verify_customer",
  "verify_invoice_records",
  "verify_subscription_state",
  "check_service_health",
] as const;

export const INVESTIGATION_TOOL_STATUSES = [
  "succeeded",
  "not_found",
  "invalid_request",
  "unavailable",
] as const;

export const INVESTIGATION_VALIDATION_OUTCOMES = ["passed", "failed"] as const;
export const SYNTHETIC_SERVICE_IDS = ["svc-api", "svc-billing", "svc-dashboard"] as const;

export const InvestigationToolNameSchema = z.enum(INVESTIGATION_TOOL_NAMES);
export const InvestigationToolPurposeSchema = z.enum(INVESTIGATION_TOOL_PURPOSES);
export const InvestigationToolStatusSchema = z.enum(INVESTIGATION_TOOL_STATUSES);
export const InvestigationValidationOutcomeSchema = z.enum(INVESTIGATION_VALIDATION_OUTCOMES);

export const CustomerIdSchema = z
  .string()
  .regex(/^CUST-DEMO-[0-9]{4}$/, "Use a canonical synthetic customer ID.");
export const InvoiceIdSchema = z
  .string()
  .regex(/^INV-DEMO-[0-9]{4}$/, "Use a canonical synthetic invoice ID.");
export const SubscriptionIdSchema = z
  .string()
  .regex(/^SUB-DEMO-[0-9]{4}$/, "Use a canonical synthetic subscription ID.");
export const ServiceIdSchema = z.enum(SYNTHETIC_SERVICE_IDS);
export const IncidentIdSchema = z
  .string()
  .regex(/^INC-DEMO-[0-9]{4}$/, "Use a canonical synthetic incident ID.");

const UniqueInvoiceIdsSchema = z
  .array(InvoiceIdSchema)
  .min(1)
  .max(5)
  .refine((value) => new Set(value).size === value.length, "Invoice IDs must be unique.");

export const SearchKnowledgeArgumentsSchema = z
  .object({
    query: z.string().trim().min(2).max(500),
    category: z.enum(CATEGORIES).optional(),
  })
  .strict();
export const GetCustomerProfileArgumentsSchema = z
  .object({ customerId: CustomerIdSchema })
  .strict();
export const GetInvoicesArgumentsSchema = z.union([
  z.object({ customerId: CustomerIdSchema }).strict(),
  z.object({ invoiceIds: UniqueInvoiceIdsSchema }).strict(),
]);
export const GetSubscriptionArgumentsSchema = z.object({ customerId: CustomerIdSchema }).strict();
export const GetServiceStatusArgumentsSchema = z.object({ serviceId: ServiceIdSchema }).strict();

const EvidenceKeySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z_]+:[A-Za-z0-9-]+$/);
const IsoDateSchema = z.string().date();
const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const KnowledgeEvidenceSchema = z
  .object({
    evidenceKey: EvidenceKeySchema,
    sourceType: z.literal("knowledge"),
    title: z.string().trim().min(1).max(200),
    section: z.string().trim().min(1).max(300),
    excerpt: z.string().trim().min(1).max(2_500),
    score: z.number().finite().min(-1).max(1),
  })
  .strict();

export const CustomerEvidenceSchema = z
  .object({
    evidenceKey: EvidenceKeySchema,
    sourceType: z.literal("customer_profile"),
    customerId: CustomerIdSchema,
    tier: z.enum(["standard", "premium"]),
    accountState: z.enum(["active", "restricted", "closed"]),
  })
  .strict();

export const InvoiceEvidenceSchema = z
  .object({
    evidenceKey: EvidenceKeySchema,
    sourceType: z.literal("invoice"),
    invoiceId: InvoiceIdSchema,
    customerId: CustomerIdSchema,
    status: z.enum(["settled", "open", "refunded", "void"]),
    amountMinor: z.number().int().nonnegative().max(10_000_000),
    currency: z.enum(["EUR", "USD"]),
    planCode: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9-]+$/),
    billingPeriodStart: IsoDateSchema,
    billingPeriodEnd: IsoDateSchema,
    chargedAt: IsoDateTimeSchema,
  })
  .strict();

export const SubscriptionEvidenceSchema = z
  .object({
    evidenceKey: EvidenceKeySchema,
    sourceType: z.literal("subscription"),
    subscriptionId: SubscriptionIdSchema,
    customerId: CustomerIdSchema,
    state: z.enum(["active", "paused", "canceled"]),
    planCode: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9-]+$/),
    renewalDate: IsoDateSchema.nullable(),
    pendingPlanCode: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9-]+$/)
      .nullable(),
    pendingChangeDate: IsoDateSchema.nullable(),
  })
  .strict();

const ActiveIncidentSchema = z
  .object({
    incidentId: IncidentIdSchema,
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(500),
    state: z.enum(["investigating", "identified", "monitoring"]),
    startedAt: IsoDateTimeSchema,
  })
  .strict();

export const ServiceStatusEvidenceSchema = z
  .object({
    evidenceKey: EvidenceKeySchema,
    sourceType: z.literal("service_status"),
    serviceId: ServiceIdSchema,
    label: z.string().trim().min(1).max(80),
    state: z.enum(["operational", "degraded", "outage", "maintenance"]),
    checkedAt: IsoDateTimeSchema,
    activeIncident: ActiveIncidentSchema.nullable(),
  })
  .strict();

export const InvestigationEvidenceSchema = z.discriminatedUnion("sourceType", [
  KnowledgeEvidenceSchema,
  CustomerEvidenceSchema,
  InvoiceEvidenceSchema,
  SubscriptionEvidenceSchema,
  ServiceStatusEvidenceSchema,
]);

function resultSchema<T extends z.ZodType<{ evidenceKey: string }>>(
  toolName: (typeof INVESTIGATION_TOOL_NAMES)[number],
  evidenceSchema: T,
  maximumRecords: number,
) {
  return z
    .object({
      schemaVersion: z.literal(TOOL_SCHEMA_VERSION),
      toolName: z.literal(toolName),
      status: z.enum(["succeeded", "not_found", "unavailable"]),
      evidence: z.array(evidenceSchema).max(maximumRecords),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.status === "succeeded" && value.evidence.length === 0) {
        context.addIssue({ code: "custom", message: "Successful results require evidence." });
      }
      if (value.status !== "succeeded" && value.evidence.length !== 0) {
        context.addIssue({ code: "custom", message: "Failed lookups cannot include evidence." });
      }
      const evidenceKeys = value.evidence.map((evidence) => evidence.evidenceKey);
      if (new Set(evidenceKeys).size !== evidenceKeys.length) {
        context.addIssue({ code: "custom", message: "Evidence keys must be unique." });
      }
    });
}

export const SearchKnowledgeResultSchema = resultSchema(
  "searchKnowledge",
  KnowledgeEvidenceSchema,
  5,
);
export const GetCustomerProfileResultSchema = resultSchema(
  "getCustomerProfile",
  CustomerEvidenceSchema,
  1,
);
export const GetInvoicesResultSchema = resultSchema("getInvoices", InvoiceEvidenceSchema, 5);
export const GetSubscriptionResultSchema = resultSchema(
  "getSubscription",
  SubscriptionEvidenceSchema,
  1,
);
export const GetServiceStatusResultSchema = resultSchema(
  "getServiceStatus",
  ServiceStatusEvidenceSchema,
  1,
);

export const InvestigationToolResultSchema = z.discriminatedUnion("toolName", [
  SearchKnowledgeResultSchema,
  GetCustomerProfileResultSchema,
  GetInvoicesResultSchema,
  GetSubscriptionResultSchema,
  GetServiceStatusResultSchema,
]);

export const ToolCatalogDescriptorSchema = z
  .object({
    version: z.literal(TOOL_CATALOG_VERSION),
    schemaVersion: z.literal(TOOL_SCHEMA_VERSION),
    tools: z
      .array(
        z
          .object({
            name: InvestigationToolNameSchema,
            purpose: InvestigationToolPurposeSchema,
          })
          .strict(),
      )
      .length(INVESTIGATION_TOOL_NAMES.length),
  })
  .strict();

export type InvestigationToolName = z.infer<typeof InvestigationToolNameSchema>;
export type InvestigationToolPurpose = z.infer<typeof InvestigationToolPurposeSchema>;
export type InvestigationToolStatus = z.infer<typeof InvestigationToolStatusSchema>;
export type InvestigationEvidence = z.infer<typeof InvestigationEvidenceSchema>;
export type InvestigationToolResult = z.infer<typeof InvestigationToolResultSchema>;
export type SearchKnowledgeArguments = z.infer<typeof SearchKnowledgeArgumentsSchema>;
export type GetCustomerProfileArguments = z.infer<typeof GetCustomerProfileArgumentsSchema>;
export type GetInvoicesArguments = z.infer<typeof GetInvoicesArgumentsSchema>;
export type GetSubscriptionArguments = z.infer<typeof GetSubscriptionArgumentsSchema>;
export type GetServiceStatusArguments = z.infer<typeof GetServiceStatusArgumentsSchema>;
