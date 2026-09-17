import { describe, expect, it } from "vitest";

import {
  GetCustomerProfileArgumentsSchema,
  GetInvoicesArgumentsSchema,
  GetServiceStatusArgumentsSchema,
  GetSubscriptionArgumentsSchema,
  INVESTIGATION_TOOL_NAMES,
  InvestigationToolResultSchema,
  SearchKnowledgeArgumentsSchema,
  TOOL_CATALOG_VERSION,
  TOOL_SCHEMA_VERSION,
} from "@/domain/investigation-tools";

describe("investigation tool contracts", () => {
  it("keeps the exact versioned five-tool allowlist", () => {
    expect(TOOL_CATALOG_VERSION).toBe("tool-catalog.v1");
    expect(TOOL_SCHEMA_VERSION).toBe("tool-schema.v1");
    expect(INVESTIGATION_TOOL_NAMES).toEqual([
      "searchKnowledge",
      "getCustomerProfile",
      "getInvoices",
      "getSubscription",
      "getServiceStatus",
    ]);
  });

  it("strictly bounds knowledge arguments", () => {
    expect(SearchKnowledgeArgumentsSchema.safeParse({ query: "refund", extra: true }).success).toBe(
      false,
    );
    expect(SearchKnowledgeArgumentsSchema.safeParse({ query: "x".repeat(501) }).success).toBe(
      false,
    );
    expect(
      SearchKnowledgeArgumentsSchema.safeParse({ query: "refund", category: "sales" }).success,
    ).toBe(false);
    expect(SearchKnowledgeArgumentsSchema.parse({ query: "  refund policy  " })).toEqual({
      query: "refund policy",
    });
  });

  it("rejects non-canonical structured identifiers and unknown keys", () => {
    expect(GetCustomerProfileArgumentsSchema.safeParse({ customerId: "customer-1" }).success).toBe(
      false,
    );
    expect(
      GetSubscriptionArgumentsSchema.safeParse({ customerId: "CUST-DEMO-1001", all: true }).success,
    ).toBe(false);
    expect(GetServiceStatusArgumentsSchema.safeParse({ serviceId: "svc-unknown" }).success).toBe(
      false,
    );
  });

  it("requires exactly one bounded invoice lookup mode", () => {
    expect(
      GetInvoicesArgumentsSchema.safeParse({
        customerId: "CUST-DEMO-1001",
        invoiceIds: ["INV-DEMO-2001"],
      }).success,
    ).toBe(false);
    expect(GetInvoicesArgumentsSchema.safeParse({}).success).toBe(false);
    expect(
      GetInvoicesArgumentsSchema.safeParse({
        invoiceIds: Array.from({ length: 6 }, (_, index) => `INV-DEMO-20${index + 10}`),
      }).success,
    ).toBe(false);
    expect(
      GetInvoicesArgumentsSchema.safeParse({
        invoiceIds: ["INV-DEMO-2001", "INV-DEMO-2001"],
      }).success,
    ).toBe(false);
  });

  it("rejects unbounded, mismatched, and field-expanded results", () => {
    expect(
      InvestigationToolResultSchema.safeParse({
        schemaVersion: TOOL_SCHEMA_VERSION,
        toolName: "getInvoices",
        status: "succeeded",
        evidence: [],
      }).success,
    ).toBe(false);
    expect(
      InvestigationToolResultSchema.safeParse({
        schemaVersion: TOOL_SCHEMA_VERSION,
        toolName: "getCustomerProfile",
        status: "not_found",
        evidence: [],
        rawPayload: {},
      }).success,
    ).toBe(false);
  });
});
