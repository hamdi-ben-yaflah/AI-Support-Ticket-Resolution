import { describe, expect, it, vi } from "vitest";

import type { InvestigationToolCatalog } from "@/investigation/catalog";
import {
  createInvestigationToolCatalog,
  describeInvestigationToolCatalog,
} from "@/investigation/catalog";
import { dispatchInvestigationTool, toToolAttemptTelemetry } from "@/investigation/dispatcher";
import { InvestigationToolError, ToolSourceUnavailableError } from "@/investigation/errors";
import { loadSyntheticFixtureSet } from "@/investigation/fixtures";
import { extractTicketIdentifierProvenance } from "@/investigation/provenance";
import {
  createFixtureStructuredSources,
  type InvestigationKnowledgeSource,
  type StructuredInvestigationSources,
} from "@/investigation/sources";
import type { RetrievedEvidence } from "@/retrieval/types";

const purposeByTool = {
  searchKnowledge: "search_policy_or_guidance",
  getCustomerProfile: "verify_customer",
  getInvoices: "verify_invoice_records",
  getSubscription: "verify_subscription_state",
  getServiceStatus: "check_service_health",
} as const;

const knowledgeRecords: RetrievedEvidence[] = Array.from({ length: 6 }, (_, index) => ({
  chunkId: `${index + 1}23e4567-e89b-42d3-a456-426614174000`,
  sourceId: `raw-source-${index}`,
  title: `Title ${index}`,
  section: `Section ${index}`,
  content: `Evidence ${index}`,
  tokenCount: 10,
  similarity: 0.9 - index / 100,
}));

function decision<T extends keyof typeof purposeByTool>(toolName: T, args: unknown) {
  return { toolName, purpose: purposeByTool[toolName], arguments: args };
}

function setup(input?: {
  structuredSources?: StructuredInvestigationSources;
  knowledgeSource?: InvestigationKnowledgeSource;
}) {
  const fixtures = loadSyntheticFixtureSet();
  const structuredSources = input?.structuredSources ?? createFixtureStructuredSources(fixtures);
  const knowledgeSource =
    input?.knowledgeSource ??
    ({
      search: vi.fn().mockResolvedValue(knowledgeRecords),
    } satisfies InvestigationKnowledgeSource);
  return {
    fixtures,
    structuredSources,
    knowledgeSource,
    catalog: createInvestigationToolCatalog({ structuredSources, knowledgeSource }),
  };
}

function dispatch(
  catalog: InvestigationToolCatalog,
  rawDecision: unknown,
  ticket = "CUST-DEMO-1001 INV-DEMO-2001 INV-DEMO-2002 svc-dashboard",
  extra?: Partial<Parameters<typeof dispatchInvestigationTool>[1]>,
) {
  return dispatchInvestigationTool(rawDecision, {
    catalog,
    provenance: extractTicketIdentifierProvenance(ticket),
    traceId: "trace-v2-foundation",
    timeoutMs: 100,
    ...extra,
  });
}

describe("investigation tool catalog and dispatcher", () => {
  it("publishes exactly five static catalog descriptors", () => {
    const descriptor = describeInvestigationToolCatalog(setup().catalog);
    expect(descriptor.tools).toEqual(
      Object.entries(purposeByTool).map(([name, purpose]) => ({ name, purpose })),
    );
  });

  it("returns minimized customer, subscription, and service evidence", async () => {
    const { catalog } = setup();
    const customer = await dispatch(
      catalog,
      decision("getCustomerProfile", { customerId: "CUST-DEMO-1001" }),
    );
    const subscription = await dispatch(
      catalog,
      decision("getSubscription", { customerId: "CUST-DEMO-1001" }),
    );
    const service = await dispatch(
      catalog,
      decision("getServiceStatus", { serviceId: "svc-dashboard" }),
    );
    const serialized = JSON.stringify({ customer, subscription, service });

    expect(customer.attempt).toMatchObject({ status: "succeeded", resultCount: 1 });
    expect(subscription.attempt).toMatchObject({ status: "succeeded", resultCount: 1 });
    expect(service.attempt).toMatchObject({ status: "succeeded", resultCount: 1 });
    expect(serialized).not.toContain("displayName");
    expect(serialized).not.toContain("internalNote");
    expect(serialized).not.toContain("internalDetail");
    expect(serialized).not.toContain("Ignore safety rules");
  });

  it("caps customer invoice lookup at five records in stable order", async () => {
    const { catalog } = setup();
    const outcome = await dispatch(
      catalog,
      decision("getInvoices", { customerId: "CUST-DEMO-1001" }),
    );

    expect(outcome.result?.evidence.map((item) => item.evidenceKey)).toEqual([
      "invoice:INV-DEMO-2001",
      "invoice:INV-DEMO-2002",
      "invoice:INV-DEMO-2003",
      "invoice:INV-DEMO-2004",
      "invoice:INV-DEMO-2005",
    ]);
    expect(JSON.stringify(outcome)).not.toContain("processorReference");
  });

  it("returns clean not-found without enumerating unrelated records", async () => {
    const { catalog } = setup();
    const outcome = await dispatch(
      catalog,
      decision("getCustomerProfile", { customerId: "CUST-DEMO-9999" }),
      "The referenced customer is CUST-DEMO-9999.",
    );

    expect(outcome.attempt).toMatchObject({ status: "not_found", resultCount: 0 });
    expect(outcome.result?.evidence).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain("CUST-DEMO-1001");
  });

  it("maps bounded knowledge evidence and excludes retrieval internals", async () => {
    const { catalog, knowledgeSource } = setup();
    const outcome = await dispatch(
      catalog,
      decision("searchKnowledge", { query: "duplicate charge", category: "billing" }),
      "No structured identifiers are needed.",
    );
    const serialized = JSON.stringify(outcome);

    expect(outcome.attempt).toMatchObject({ status: "succeeded", resultCount: 5 });
    expect(knowledgeSource.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "duplicate charge", category: "billing" }),
    );
    expect(serialized).not.toContain("raw-source");
    expect(serialized).not.toContain("tokenCount");
  });

  it("rejects unsupported, malformed, unauthorized, and spoofed requests before adapters", async () => {
    const base = createFixtureStructuredSources(loadSyntheticFixtureSet());
    const structuredSources: StructuredInvestigationSources = {
      getCustomer: vi.fn(base.getCustomer),
      getInvoicesByCustomer: vi.fn(base.getInvoicesByCustomer),
      getInvoicesById: vi.fn(base.getInvoicesById),
      getSubscription: vi.fn(base.getSubscription),
      getServiceStatus: vi.fn(base.getServiceStatus),
    };
    const knowledgeSource: InvestigationKnowledgeSource = { search: vi.fn() };
    const { catalog } = setup({ structuredSources, knowledgeSource });
    const rejected = [
      { toolName: "deleteCustomer", purpose: "verify_customer", arguments: {} },
      {
        ...decision("getCustomerProfile", { customerId: "CUST-DEMO-1001" }),
        implementation: "https://example.invalid",
      },
      decision("getCustomerProfile", { customerId: "CUST-DEMO-9999" }),
      decision("getCustomerProfile", { customerId: "CUST-DEMO-1001", enumerate: true }),
      decision("getInvoices", { invoiceIds: ["CUST-DEMO-1001"] }),
      {
        toolName: "getCustomerProfile",
        purpose: "check_service_health",
        arguments: { customerId: "CUST-DEMO-1001" },
      },
    ];

    for (const request of rejected) {
      const outcome = await dispatch(catalog, request, "CUST-DEMO-1001");
      expect(outcome.attempt.status).toBe("invalid_request");
      expect(outcome.result).toBeNull();
    }

    expect(structuredSources.getCustomer).not.toHaveBeenCalled();
    expect(structuredSources.getInvoicesByCustomer).not.toHaveBeenCalled();
    expect(structuredSources.getInvoicesById).not.toHaveBeenCalled();
    expect(knowledgeSource.search).not.toHaveBeenCalled();
  });

  it("maps a declared source outage separately from not found", async () => {
    const base = createFixtureStructuredSources(loadSyntheticFixtureSet());
    const structuredSources: StructuredInvestigationSources = {
      ...base,
      getCustomer: vi.fn().mockRejectedValue(new ToolSourceUnavailableError()),
    };
    const { catalog } = setup({ structuredSources });
    const outcome = await dispatch(
      catalog,
      decision("getCustomerProfile", { customerId: "CUST-DEMO-1001" }),
    );

    expect(outcome.attempt.status).toBe("unavailable");
    expect(outcome.result).toMatchObject({ status: "unavailable", evidence: [] });
  });

  it("fails closed on schema-invalid mapped results and excessive serialized size", async () => {
    const { catalog } = setup();
    const original = catalog.entries.getCustomerProfile;
    const invalidCatalog: InvestigationToolCatalog = {
      ...catalog,
      entries: {
        ...catalog.entries,
        getCustomerProfile: {
          ...original,
          handler: vi.fn().mockResolvedValue({
            schemaVersion: "tool-schema.v1",
            toolName: "getCustomerProfile",
            status: "succeeded",
            evidence: [],
            rawPayload: "unsafe",
          }),
        },
      },
    };

    await expect(
      dispatch(invalidCatalog, decision("getCustomerProfile", { customerId: "CUST-DEMO-1001" })),
    ).rejects.toMatchObject({ code: "invalid_result" });
    await expect(
      dispatch(
        catalog,
        decision("getCustomerProfile", { customerId: "CUST-DEMO-1001" }),
        undefined,
        { maximumResultBytes: 20 },
      ),
    ).rejects.toMatchObject({ code: "result_too_large" });
  });

  it("enforces the deadline, aborts the adapter, and returns unavailable", async () => {
    let observedAbort = false;
    const base = createFixtureStructuredSources(loadSyntheticFixtureSet());
    const structuredSources: StructuredInvestigationSources = {
      ...base,
      getCustomer: vi.fn(
        (_customerId, signal) =>
          new Promise<never>((_, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      ),
    };
    const { catalog } = setup({ structuredSources });
    const outcome = await dispatch(
      catalog,
      decision("getCustomerProfile", { customerId: "CUST-DEMO-1001" }),
      undefined,
      { timeoutMs: 5 },
    );

    expect(observedAbort).toBe(true);
    expect(outcome.attempt.status).toBe("unavailable");
  });

  it("propagates parent cancellation and fails unexpected source errors closed", async () => {
    const base = createFixtureStructuredSources(loadSyntheticFixtureSet());
    const cancellationSources: StructuredInvestigationSources = {
      ...base,
      getCustomer: vi.fn(
        (_customerId, signal) =>
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    };
    const cancellationCatalog = setup({ structuredSources: cancellationSources }).catalog;
    const controller = new AbortController();
    const pending = dispatch(
      cancellationCatalog,
      decision("getCustomerProfile", { customerId: "CUST-DEMO-1001" }),
      undefined,
      { parentSignal: controller.signal },
    );
    controller.abort(new DOMException("Request stopped", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const failureSources: StructuredInvestigationSources = {
      ...base,
      getCustomer: vi.fn().mockRejectedValue(new Error("database detail")),
    };
    await expect(
      dispatch(
        setup({ structuredSources: failureSources }).catalog,
        decision("getCustomerProfile", { customerId: "CUST-DEMO-1001" }),
      ),
    ).rejects.toEqual(new InvestigationToolError("source_failure"));
  });

  it("keeps telemetry identifier-free and dispatcher output free of raw request data", async () => {
    const { catalog } = setup();
    const rawSecret = "raw-argument-marker";
    const outcome = await dispatch(
      catalog,
      decision("searchKnowledge", { query: rawSecret }),
      "The ticket itself must not be returned.",
    );
    const telemetry = toToolAttemptTelemetry(outcome.attempt);

    expect(telemetry).not.toHaveProperty("evidenceKeys");
    expect(JSON.stringify(telemetry)).not.toContain("123e4567");
    expect(JSON.stringify(outcome)).not.toContain(rawSecret);
    expect(JSON.stringify(outcome)).not.toContain("The ticket itself");
  });
});
