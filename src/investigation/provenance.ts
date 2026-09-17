import { z } from "zod";

import {
  CustomerIdSchema,
  GetCustomerProfileArgumentsSchema,
  GetInvoicesArgumentsSchema,
  GetServiceStatusArgumentsSchema,
  GetSubscriptionArgumentsSchema,
  InvestigationToolResultSchema,
  InvoiceIdSchema,
  SearchKnowledgeArgumentsSchema,
  ServiceIdSchema,
  SYNTHETIC_SERVICE_IDS,
  type InvestigationToolName,
} from "@/domain/investigation-tools";

export const IdentifierProvenanceSchema = z
  .object({
    customerIds: z.array(CustomerIdSchema).max(50),
    invoiceIds: z.array(InvoiceIdSchema).max(50),
    serviceIds: z.array(ServiceIdSchema).max(SYNTHETIC_SERVICE_IDS.length),
  })
  .strict();

export type IdentifierProvenance = Readonly<{
  customerIds: readonly z.infer<typeof CustomerIdSchema>[];
  invoiceIds: readonly z.infer<typeof InvoiceIdSchema>[];
  serviceIds: readonly z.infer<typeof ServiceIdSchema>[];
}>;

function uniqueSorted<T extends string>(values: Iterable<T>): readonly T[] {
  return Object.freeze([...new Set(values)].sort());
}

function createProvenance(input: z.input<typeof IdentifierProvenanceSchema>): IdentifierProvenance {
  const parsed = IdentifierProvenanceSchema.parse(input);
  return Object.freeze({
    customerIds: uniqueSorted(parsed.customerIds),
    invoiceIds: uniqueSorted(parsed.invoiceIds),
    serviceIds: uniqueSorted(parsed.serviceIds),
  });
}

function extractPattern(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)]
    .map((match) => match[1])
    .filter((value) => value !== undefined);
}

export function extractTicketIdentifierProvenance(ticketText: string): IdentifierProvenance {
  const customerIds = extractPattern(
    ticketText,
    /(?:^|[^A-Za-z0-9-])(CUST-DEMO-[0-9]{4})(?=$|[^A-Za-z0-9-])/g,
  );
  const invoiceIds = extractPattern(
    ticketText,
    /(?:^|[^A-Za-z0-9-])(INV-DEMO-[0-9]{4})(?=$|[^A-Za-z0-9-])/g,
  );
  const serviceIds = SYNTHETIC_SERVICE_IDS.filter((serviceId) => {
    const escaped = serviceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^A-Za-z0-9-])${escaped}(?=$|[^A-Za-z0-9-])`).test(ticketText);
  });

  return createProvenance({ customerIds, invoiceIds, serviceIds });
}

export function addValidatedResultProvenance(
  provenance: IdentifierProvenance,
  rawResult: unknown,
): IdentifierProvenance {
  const result = InvestigationToolResultSchema.parse(rawResult);
  const customerIds = new Set(provenance.customerIds);
  const invoiceIds = new Set(provenance.invoiceIds);
  const serviceIds = new Set(provenance.serviceIds);

  for (const evidence of result.evidence) {
    switch (evidence.sourceType) {
      case "customer_profile":
        customerIds.add(evidence.customerId);
        break;
      case "invoice":
        customerIds.add(evidence.customerId);
        invoiceIds.add(evidence.invoiceId);
        break;
      case "subscription":
        customerIds.add(evidence.customerId);
        break;
      case "service_status":
        serviceIds.add(evidence.serviceId);
        break;
      case "knowledge":
        break;
    }
  }

  return createProvenance({
    customerIds: [...customerIds],
    invoiceIds: [...invoiceIds],
    serviceIds: [...serviceIds],
  });
}

export function authorizeToolArguments(
  toolName: InvestigationToolName,
  rawArguments: unknown,
  provenance: IdentifierProvenance,
): boolean {
  const customerIds = new Set(provenance.customerIds);
  const invoiceIds = new Set(provenance.invoiceIds);
  const serviceIds = new Set(provenance.serviceIds);

  switch (toolName) {
    case "searchKnowledge":
      return SearchKnowledgeArgumentsSchema.safeParse(rawArguments).success;
    case "getCustomerProfile": {
      const parsed = GetCustomerProfileArgumentsSchema.safeParse(rawArguments);
      return parsed.success && customerIds.has(parsed.data.customerId);
    }
    case "getInvoices": {
      const parsed = GetInvoicesArgumentsSchema.safeParse(rawArguments);
      if (!parsed.success) return false;
      return "customerId" in parsed.data
        ? customerIds.has(parsed.data.customerId)
        : parsed.data.invoiceIds.every((invoiceId) => invoiceIds.has(invoiceId));
    }
    case "getSubscription": {
      const parsed = GetSubscriptionArgumentsSchema.safeParse(rawArguments);
      return parsed.success && customerIds.has(parsed.data.customerId);
    }
    case "getServiceStatus": {
      const parsed = GetServiceStatusArgumentsSchema.safeParse(rawArguments);
      return parsed.success && serviceIds.has(parsed.data.serviceId);
    }
  }
}
