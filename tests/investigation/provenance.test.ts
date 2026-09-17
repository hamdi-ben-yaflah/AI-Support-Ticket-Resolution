import { describe, expect, it } from "vitest";

import { TOOL_SCHEMA_VERSION } from "@/domain/investigation-tools";
import {
  addValidatedResultProvenance,
  authorizeToolArguments,
  extractTicketIdentifierProvenance,
} from "@/investigation/provenance";

describe("investigation identifier provenance", () => {
  it("extracts only exact canonical ticket identifiers and enumerated services", () => {
    const provenance = extractTicketIdentifierProvenance(
      "Use CUST-DEMO-1001, INV-DEMO-2002 and svc-api; ignore cust-demo-1002, CUST-DEMO-12 and svc-unknown.",
    );

    expect(provenance).toEqual({
      customerIds: ["CUST-DEMO-1001"],
      invoiceIds: ["INV-DEMO-2002"],
      serviceIds: ["svc-api"],
    });
    expect(Object.isFrozen(provenance.customerIds)).toBe(true);
  });

  it("authorizes exact identifier kinds without enumeration", () => {
    const provenance = extractTicketIdentifierProvenance(
      "Customer CUST-DEMO-1001 mentions invoice INV-DEMO-2001 and svc-dashboard.",
    );

    expect(
      authorizeToolArguments("getCustomerProfile", { customerId: "CUST-DEMO-1001" }, provenance),
    ).toBe(true);
    expect(
      authorizeToolArguments("getCustomerProfile", { customerId: "CUST-DEMO-9999" }, provenance),
    ).toBe(false);
    expect(
      authorizeToolArguments("getInvoices", { invoiceIds: ["INV-DEMO-2001"] }, provenance),
    ).toBe(true);
    expect(
      authorizeToolArguments("getInvoices", { invoiceIds: ["INV-DEMO-9999"] }, provenance),
    ).toBe(false);
    expect(
      authorizeToolArguments("getServiceStatus", { serviceId: "svc-dashboard" }, provenance),
    ).toBe(true);
  });

  it("adds identifiers only from typed result identifier fields", () => {
    const initial = extractTicketIdentifierProvenance("Please search the policy.");
    const fromKnowledge = addValidatedResultProvenance(initial, {
      schemaVersion: TOOL_SCHEMA_VERSION,
      toolName: "searchKnowledge",
      status: "succeeded",
      evidence: [
        {
          evidenceKey: "knowledge:123e4567-e89b-42d3-a456-426614174000",
          sourceType: "knowledge",
          title: "Example",
          section: "Data",
          excerpt: "Untrusted text mentions CUST-DEMO-1001 and INV-DEMO-2001.",
          score: 0.9,
        },
      ],
    });
    expect(fromKnowledge.customerIds).toEqual([]);
    expect(fromKnowledge.invoiceIds).toEqual([]);

    const fromInvoice = addValidatedResultProvenance(fromKnowledge, {
      schemaVersion: TOOL_SCHEMA_VERSION,
      toolName: "getInvoices",
      status: "succeeded",
      evidence: [
        {
          evidenceKey: "invoice:INV-DEMO-2001",
          sourceType: "invoice",
          invoiceId: "INV-DEMO-2001",
          customerId: "CUST-DEMO-1001",
          status: "settled",
          amountMinor: 4900,
          currency: "USD",
          planCode: "pro-monthly",
          billingPeriodStart: "2026-08-01",
          billingPeriodEnd: "2026-08-31",
          chargedAt: "2026-08-01T08:15:00Z",
        },
      ],
    });
    expect(fromInvoice.customerIds).toEqual(["CUST-DEMO-1001"]);
    expect(fromInvoice.invoiceIds).toEqual(["INV-DEMO-2001"]);
    expect(
      authorizeToolArguments("getSubscription", { customerId: "CUST-DEMO-1001" }, fromInvoice),
    ).toBe(true);
  });
});
