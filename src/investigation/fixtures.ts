import "server-only";

import { z } from "zod";

import customersJson from "../../data/synthetic-sources/v1/customers.json";
import invoicesJson from "../../data/synthetic-sources/v1/invoices.json";
import manifestJson from "../../data/synthetic-sources/v1/manifest.json";
import serviceStatusJson from "../../data/synthetic-sources/v1/service-status.json";
import subscriptionsJson from "../../data/synthetic-sources/v1/subscriptions.json";
import {
  CustomerIdSchema,
  IncidentIdSchema,
  InvoiceIdSchema,
  ServiceIdSchema,
  SubscriptionIdSchema,
  SYNTHETIC_SERVICE_IDS,
  SYNTHETIC_SOURCES_VERSION,
} from "@/domain/investigation-tools";

const IsoDateSchema = z.string().date();
const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const SyntheticManifestFixtureSchema = z
  .object({
    version: z.literal(SYNTHETIC_SOURCES_VERSION),
    description: z.string().trim().min(1).max(240),
  })
  .strict();

export const SyntheticCustomerFixtureSchema = z
  .object({
    id: CustomerIdSchema,
    tier: z.enum(["standard", "premium"]),
    accountState: z.enum(["active", "restricted", "closed"]),
    displayName: z.string().trim().min(1).max(100),
    internalNote: z.string().trim().min(1).max(300),
  })
  .strict();

export const SyntheticInvoiceFixtureSchema = z
  .object({
    id: InvoiceIdSchema,
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
    processorReference: z.string().trim().min(1).max(80),
  })
  .strict()
  .refine((value) => value.billingPeriodStart <= value.billingPeriodEnd, {
    message: "Invoice billing periods must be ordered.",
  });

export const SyntheticSubscriptionFixtureSchema = z
  .object({
    id: SubscriptionIdSchema,
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
    internalNote: z.string().trim().min(1).max(300),
  })
  .strict()
  .refine((value) => (value.pendingPlanCode === null) === (value.pendingChangeDate === null), {
    message: "Pending subscription plans and dates must be provided together.",
  });

const SyntheticIncidentFixtureSchema = z
  .object({
    id: IncidentIdSchema,
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(500),
    state: z.enum(["investigating", "identified", "monitoring"]),
    startedAt: IsoDateTimeSchema,
    internalDetail: z.string().trim().min(1).max(300),
  })
  .strict();

export const SyntheticServiceStatusFixtureSchema = z
  .object({
    id: ServiceIdSchema,
    label: z.string().trim().min(1).max(80),
    state: z.enum(["operational", "degraded", "outage", "maintenance"]),
    checkedAt: IsoDateTimeSchema,
    activeIncident: SyntheticIncidentFixtureSchema.nullable(),
    internalNote: z.string().trim().min(1).max(300),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "operational" && value.activeIncident !== null) {
      context.addIssue({ code: "custom", message: "Operational services cannot have incidents." });
    }
    if (value.state !== "operational" && value.activeIncident === null) {
      context.addIssue({
        code: "custom",
        message: "Non-operational services require an incident.",
      });
    }
  });

function addDuplicateIssues(
  values: readonly { id: string }[],
  path: string,
  context: z.RefinementCtx,
) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      context.addIssue({
        code: "custom",
        path: [path],
        message: `Duplicate fixture ID: ${value.id}`,
      });
    }
    seen.add(value.id);
  }
}

export const SyntheticFixtureBundleSchema = z
  .object({
    manifest: SyntheticManifestFixtureSchema,
    customers: z.array(SyntheticCustomerFixtureSchema).min(1).max(50),
    invoices: z.array(SyntheticInvoiceFixtureSchema).min(1).max(100),
    subscriptions: z.array(SyntheticSubscriptionFixtureSchema).min(1).max(50),
    serviceStatuses: z
      .array(SyntheticServiceStatusFixtureSchema)
      .length(SYNTHETIC_SERVICE_IDS.length),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(value.customers, "customers", context);
    addDuplicateIssues(value.invoices, "invoices", context);
    addDuplicateIssues(value.subscriptions, "subscriptions", context);
    addDuplicateIssues(value.serviceStatuses, "serviceStatuses", context);
    addDuplicateIssues(
      value.serviceStatuses.flatMap((service) =>
        service.activeIncident ? [service.activeIncident] : [],
      ),
      "serviceStatuses",
      context,
    );

    const customerIds = new Set(value.customers.map((item) => item.id));
    for (const invoice of value.invoices) {
      if (!customerIds.has(invoice.customerId)) {
        context.addIssue({
          code: "custom",
          path: ["invoices"],
          message: `Invoice references an unknown customer: ${invoice.customerId}`,
        });
      }
    }

    const subscriptionCustomerIds = new Set<string>();
    for (const subscription of value.subscriptions) {
      if (!customerIds.has(subscription.customerId)) {
        context.addIssue({
          code: "custom",
          path: ["subscriptions"],
          message: `Subscription references an unknown customer: ${subscription.customerId}`,
        });
      }
      if (subscriptionCustomerIds.has(subscription.customerId)) {
        context.addIssue({
          code: "custom",
          path: ["subscriptions"],
          message: `Customer has multiple current subscriptions: ${subscription.customerId}`,
        });
      }
      subscriptionCustomerIds.add(subscription.customerId);
    }

    const actualServices = new Set(value.serviceStatuses.map((item) => item.id));
    for (const serviceId of SYNTHETIC_SERVICE_IDS) {
      if (!actualServices.has(serviceId)) {
        context.addIssue({
          code: "custom",
          path: ["serviceStatuses"],
          message: `Missing enumerated service: ${serviceId}`,
        });
      }
    }
  });

type SyntheticFixtureBundle = z.infer<typeof SyntheticFixtureBundleSchema>;
type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;
export type SyntheticCustomerFixture = DeepReadonly<z.infer<typeof SyntheticCustomerFixtureSchema>>;
export type SyntheticInvoiceFixture = DeepReadonly<z.infer<typeof SyntheticInvoiceFixtureSchema>>;
export type SyntheticSubscriptionFixture = DeepReadonly<
  z.infer<typeof SyntheticSubscriptionFixtureSchema>
>;
export type SyntheticServiceStatusFixture = DeepReadonly<
  z.infer<typeof SyntheticServiceStatusFixtureSchema>
>;

export type SyntheticFixtureIndex = Readonly<{
  version: typeof SYNTHETIC_SOURCES_VERSION;
  customers: readonly SyntheticCustomerFixture[];
  invoices: readonly SyntheticInvoiceFixture[];
  subscriptions: readonly SyntheticSubscriptionFixture[];
  serviceStatuses: readonly SyntheticServiceStatusFixture[];
  customerById: Readonly<Record<string, SyntheticCustomerFixture>>;
  invoiceById: Readonly<Record<string, SyntheticInvoiceFixture>>;
  subscriptionByCustomerId: Readonly<Record<string, SyntheticSubscriptionFixture>>;
  serviceStatusById: Readonly<Record<string, SyntheticServiceStatusFixture>>;
}>;

function indexBy<T extends { readonly id: string }>(
  values: readonly T[],
): Readonly<Record<string, T>> {
  return Object.freeze(Object.fromEntries(values.map((value) => [value.id, value])));
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function freezeRecords<T extends object>(values: readonly T[]): readonly DeepReadonly<T>[] {
  return Object.freeze(values.map(deepFreeze));
}

export function parseSyntheticFixtureSet(input: unknown): SyntheticFixtureIndex {
  const parsed: SyntheticFixtureBundle = SyntheticFixtureBundleSchema.parse(input);
  const customers = freezeRecords(parsed.customers);
  const invoices = freezeRecords(parsed.invoices);
  const subscriptions = freezeRecords(parsed.subscriptions);
  const serviceStatuses = freezeRecords(parsed.serviceStatuses);

  return Object.freeze({
    version: parsed.manifest.version,
    customers,
    invoices,
    subscriptions,
    serviceStatuses,
    customerById: indexBy(customers),
    invoiceById: indexBy(invoices),
    subscriptionByCustomerId: Object.freeze(
      Object.fromEntries(subscriptions.map((value) => [value.customerId, value])),
    ),
    serviceStatusById: indexBy(serviceStatuses),
  });
}

let loadedFixtures: SyntheticFixtureIndex | undefined;

export function loadSyntheticFixtureSet(): SyntheticFixtureIndex {
  loadedFixtures ??= parseSyntheticFixtureSet({
    manifest: manifestJson,
    customers: customersJson,
    invoices: invoicesJson,
    subscriptions: subscriptionsJson,
    serviceStatuses: serviceStatusJson,
  });
  return loadedFixtures;
}
