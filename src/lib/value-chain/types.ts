import { z } from "zod";

/**
 * Value chain: the upstream and downstream counterparties whose emissions
 * make up the client's Scope 3, the state of each year's engagement with
 * them, and the emissions data they return.
 *
 * Three records per counterparty and reporting year:
 *
 * - an engagement, which holds where the request for data has got to and
 *   writes an audit event on every transition;
 * - an annual GHG report, the figures a counterparty publishes or sends and
 *   the basis on which a share of them is attributed to the client;
 * - an activity ledger, the alternative for a counterparty that has no
 *   report: lines of physical activity, each pointing at a DESNZ row, on the
 *   same contract as the emissions and transport modules.
 *
 * The minimum ask of every counterparty is an annual GHG report; a ledger is
 * accepted where none exists. Figures are computed here from those records
 * and never typed in as a total.
 */
const optionalText = (max: number) => z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().max(max).optional());
const optionalNumber = z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number().optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const year = z.preprocess((v) => (typeof v === "string" ? Number(v) : v), z.number().int().min(2000).max(2100));

/* ------------------------------------------------------------------ */
/* roles, direction and GHG Protocol categories                        */
/* ------------------------------------------------------------------ */

export type Direction = "upstream" | "downstream";

export interface RoleMeta {
  label: string;
  direction: Direction;
  /** Scope 3 categories the relationship usually serves, by number. */
  categories: string[];
}

/** A counterparty holds a set of roles, because one legal entity is often several things at once. */
export const ROLES: Record<string, RoleMeta> = {
  supplier: { label: "Supplier of goods or services", direction: "upstream", categories: ["1"] },
  capital_supplier: { label: "Supplier of capital goods", direction: "upstream", categories: ["2"] },
  energy_supplier: { label: "Energy or fuel supplier", direction: "upstream", categories: ["3"] },
  distributor: { label: "Distributor", direction: "upstream", categories: ["1", "4"] },
  logistics: { label: "Logistics or haulage provider", direction: "upstream", categories: ["4"] },
  waste_contractor: { label: "Waste contractor", direction: "upstream", categories: ["5"] },
  travel_provider: { label: "Travel provider", direction: "upstream", categories: ["6"] },
  landlord: { label: "Landlord (we lease from them)", direction: "upstream", categories: ["8"] },
  franchisor: { label: "Franchisor or brand licensor", direction: "upstream", categories: ["1"] },
  outbound_logistics: { label: "Outbound logistics provider", direction: "downstream", categories: ["9"] },
  processor: { label: "Processor of sold products", direction: "downstream", categories: ["10"] },
  customer: { label: "Customer", direction: "downstream", categories: ["11", "12"] },
  tenant: { label: "Tenant or concession (we lease to them)", direction: "downstream", categories: ["13"] },
  franchisee: { label: "Franchisee", direction: "downstream", categories: ["14"] },
  investee: { label: "Investee", direction: "downstream", categories: ["15"] },
};
export const ROLE_IDS = Object.keys(ROLES) as [string, ...string[]];

export const SCOPE3_CATEGORIES: Record<string, string> = {
  "1": "Purchased goods and services",
  "2": "Capital goods",
  "3": "Fuel- and energy-related activities",
  "4": "Upstream transportation and distribution",
  "5": "Waste generated in operations",
  "6": "Business travel",
  "7": "Employee commuting",
  "8": "Upstream leased assets",
  "9": "Downstream transportation and distribution",
  "10": "Processing of sold products",
  "11": "Use of sold products",
  "12": "End-of-life treatment of sold products",
  "13": "Downstream leased assets",
  "14": "Franchises",
  "15": "Investments",
};
export const SCOPE3_CATEGORY_IDS = Object.keys(SCOPE3_CATEGORIES) as [string, ...string[]];
export const categoryLabel = (id: string) => `Category ${id} ${SCOPE3_CATEGORIES[id] ?? "unknown"}`;

/** Upstream, downstream or both, from the roles held. */
export function directionOf(roles: readonly string[]): "upstream" | "downstream" | "both" | "unknown" {
  const set = new Set(roles.map((r) => ROLES[r]?.direction).filter(Boolean));
  if (set.size === 0) return "unknown";
  if (set.size === 2) return "both";
  return set.has("upstream") ? "upstream" : "downstream";
}

/** The categories the roles imply, used when none is stated. */
export function defaultCategories(roles: readonly string[]): string[] {
  return [...new Set(roles.flatMap((r) => ROLES[r]?.categories ?? []))].sort((a, b) => Number(a) - Number(b));
}

/* ------------------------------------------------------------------ */
/* what is asked for                                                   */
/* ------------------------------------------------------------------ */

/**
 * The minimum ask is an annual GHG report. A counterparty that has none is
 * asked for an activity ledger instead, which the portal converts with the
 * same published factors it uses for the client's own activity.
 */
export const ASKS = ["annual_ghg_report", "activity_ledger", "either"] as const;
export type Ask = (typeof ASKS)[number];
export const ASK_LABELS: Record<Ask, string> = {
  annual_ghg_report: "Annual GHG report (Scope 1, 2 and 3 with boundary and methodology)",
  activity_ledger: "Activity ledger (energy, fuel, distance, tonnage by period)",
  either: "Annual GHG report, or an activity ledger where none exists",
};

export const COUNTERPARTY_STATUSES = ["active", "inactive"] as const;

/* ------------------------------------------------------------------ */
/* engagement lifecycle                                                */
/* ------------------------------------------------------------------ */

export const ENGAGEMENT_STATES = ["identified", "contacted", "engaged", "responding", "complete", "verified", "declined", "unreachable"] as const;
export type EngagementState = (typeof ENGAGEMENT_STATES)[number];

export const STATE_LABELS: Record<EngagementState, string> = {
  identified: "Identified, not yet asked",
  contacted: "Request sent, no reply",
  engaged: "In conversation, no data yet",
  responding: "Data arriving",
  complete: "Data received, awaiting review",
  verified: "Reviewed and verified",
  declined: "Declined",
  unreachable: "Unreachable",
};

/** Actions a user records against an engagement. Each is a transition, or a note that leaves the state alone. */
export const ENGAGEMENT_ACTIONS = [
  "request_sent",
  "reminder_sent",
  "escalated",
  "reply_received",
  "data_received",
  "marked_complete",
  "verified",
  "declined",
  "unreachable",
  "reopened",
  "note",
] as const;
export type EngagementAction = (typeof ENGAGEMENT_ACTIONS)[number];

export const CHANNELS = ["email", "portal", "phone", "meeting", "letter", "other"] as const;

export const DECLINE_REASONS = {
  vsme_right_to_refuse: "Sub-1,000-employee supplier declining beyond VSME (Omnibus)",
  commercial_confidentiality: "Commercial confidentiality",
  no_capability: "No capability to produce the data",
  not_material: "Counterparty considers the relationship immaterial",
  other: "Other",
} as const;
export const DECLINE_REASON_IDS = Object.keys(DECLINE_REASONS) as [string, ...string[]];

/* ------------------------------------------------------------------ */
/* data quality tiers (GHG Protocol Scope 3 technical guidance)         */
/* ------------------------------------------------------------------ */

export type Tier = "A" | "B" | "C" | "D" | "E";
export const TIER_LABELS: Record<Tier, string> = {
  A: "Supplier-specific",
  B: "Hybrid (supplier-reported, allocated)",
  C: "Average data (physical quantity × published factor)",
  D: "Spend-based",
  E: "Estimated or extrapolated",
};
/** Tiers A and B count as primary data for the ESRS E1-6 split. */
export const isPrimary = (t: Tier | null) => t === "A" || t === "B";

/* ------------------------------------------------------------------ */
/* counterparty                                                        */
/* ------------------------------------------------------------------ */

const roleList = z.preprocess(
  (v) => (typeof v === "string" ? v.split(/[;,|]/).map((s) => s.trim()).filter(Boolean) : v),
  z.array(z.enum(ROLE_IDS)).min(1, "at least one role is required"),
);
const categoryList = z.preprocess(
  (v) => (typeof v === "string" ? v.split(/[;,|]/).map((s) => s.trim().replace(/^cat(egory)?\s*/i, "")).filter(Boolean) : v === null ? undefined : v),
  z.array(z.enum(SCOPE3_CATEGORY_IDS)).optional(),
);

export const counterpartyCreateSchema = z.object({
  name: z.string().min(1).max(200),
  companyNumber: optionalText(20),
  sector: optionalText(120),
  country: z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : String(v).toUpperCase()), z.string().max(2).optional()),
  roles: roleList,
  /** Scope 3 categories the relationship serves. Defaults from the roles. */
  ghgCategories: categoryList,
  /** Annual spend with an upstream counterparty, or revenue from a downstream one, in GBP. Drives ranking. */
  annualValueGbp: optionalNumber.pipe(z.number().nonnegative().optional()),
  contactName: optionalText(120),
  contactEmail: optionalText(200),
  escalationName: optionalText(120),
  escalationEmail: optionalText(200),
  ask: z.enum(ASKS).default("annual_ghg_report"),
  status: z.enum(COUNTERPARTY_STATUSES).default("active"),
  notes: optionalText(2000),
});
export type CounterpartyCreate = z.infer<typeof counterpartyCreateSchema>;

export const counterpartyUpdateSchema = counterpartyCreateSchema.partial();
export type CounterpartyUpdate = z.infer<typeof counterpartyUpdateSchema>;

export interface CounterpartyRecord extends Omit<CounterpartyCreate, "ghgCategories"> {
  id: string;
  ghgCategories: string[];
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* engagement                                                          */
/* ------------------------------------------------------------------ */

export interface EngagementRecord {
  id: string;
  counterpartyId: string;
  reportingYear: number;
  state: EngagementState;
  ask: Ask;
  /** Date the data is needed by, YYYY-MM-DD. */
  dueOn?: string;
  lastContactOn?: string;
  remindersSent: number;
  escalated: boolean;
  declineReason?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EngagementEvent {
  id: string;
  engagementId: string;
  at: string;
  action: EngagementAction;
  fromState: EngagementState;
  toState: EngagementState;
  channel?: string;
  detail?: string;
  actor?: string;
}

export const engagementActionSchema = z
  .object({
    reportingYear: year,
    action: z.enum(ENGAGEMENT_ACTIONS),
    /** Date the action happened, YYYY-MM-DD; defaults to today. */
    on: isoDate.optional(),
    channel: z.enum(CHANNELS).optional(),
    detail: optionalText(2000),
    actor: optionalText(120),
    /** request_sent: the deadline given to the counterparty. */
    dueOn: isoDate.optional(),
    /** request_sent: what was asked for; defaults to the counterparty's ask. */
    ask: z.enum(ASKS).optional(),
    /** data_received: true when everything asked for has arrived. */
    complete: z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean().optional()),
    /** declined: why. */
    declineReason: z.enum(DECLINE_REASON_IDS).optional(),
  })
  .refine((v) => v.action !== "declined" || v.declineReason !== undefined, { message: "a decline needs a reason", path: ["declineReason"] });
export type EngagementActionInput = z.infer<typeof engagementActionSchema>;

/* ------------------------------------------------------------------ */
/* annual GHG report                                                   */
/* ------------------------------------------------------------------ */

/**
 * How the counterparty's reported figures are attributed to the client.
 *
 * - supplier_total      the whole footprint is counted (a dedicated supplier or a wholly-leased asset)
 * - spend_share         reported total × our annual value ÷ their revenue
 * - supplier_allocated  the counterparty stated the share attributable to us
 * - product_specific    a product or service footprint for exactly what we bought
 */
export const ALLOCATION_METHODS = ["supplier_total", "spend_share", "supplier_allocated", "product_specific"] as const;
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];
export const ALLOCATION_LABELS: Record<AllocationMethod, string> = {
  supplier_total: "Whole reported footprint",
  spend_share: "Share of revenue (our spend ÷ their revenue)",
  supplier_allocated: "Allocated by the counterparty",
  product_specific: "Product- or service-specific footprint",
};

export const METHODOLOGIES = ["ghg_protocol", "iso_14064", "vsme", "other"] as const;
export const BOUNDARIES = ["operational_control", "financial_control", "equity_share", "unknown"] as const;
export const ASSURANCE_LEVELS = ["none", "limited", "reasonable"] as const;
export const REPORT_BASES = ["supplier_reported", "public_report", "estimated"] as const;

export const emissionsReportCreateSchema = z
  .object({
    counterpartyId: z.string().min(1),
    reportingYear: year,
    periodStart: isoDate,
    periodEnd: isoDate,
    scope1Tco2e: optionalNumber.pipe(z.number().nonnegative().optional()),
    scope2LocationTco2e: optionalNumber.pipe(z.number().nonnegative().optional()),
    scope2MarketTco2e: optionalNumber.pipe(z.number().nonnegative().optional()),
    scope3Tco2e: optionalNumber.pipe(z.number().nonnegative().optional()),
    allocationMethod: z.enum(ALLOCATION_METHODS),
    /** supplier_allocated and product_specific: the tCO2e attributable to us. */
    allocatedTco2e: optionalNumber.pipe(z.number().nonnegative().optional()),
    /** spend_share: the counterparty's revenue for the period, GBP. */
    supplierRevenueGbp: optionalNumber.pipe(z.number().positive().optional()),
    methodology: z.enum(METHODOLOGIES).default("ghg_protocol"),
    boundary: z.enum(BOUNDARIES).default("unknown"),
    assurance: z.enum(ASSURANCE_LEVELS).default("none"),
    assuranceProvider: optionalText(120),
    basis: z.enum(REPORT_BASES).default("supplier_reported"),
    /** The document the figures came from: report title and page, file name, email date. */
    evidence: optionalText(300),
    documentDate: isoDate.optional(),
    notes: optionalText(2000),
  })
  .refine((v) => v.periodEnd >= v.periodStart, { message: "periodEnd must not be before periodStart", path: ["periodEnd"] })
  .refine((v) => [v.scope1Tco2e, v.scope2LocationTco2e, v.scope2MarketTco2e, v.scope3Tco2e, v.allocatedTco2e].some((n) => n !== undefined), {
    message: "at least one emissions figure is required",
    path: ["scope1Tco2e"],
  })
  .refine((v) => (v.allocationMethod === "supplier_allocated" || v.allocationMethod === "product_specific" ? v.allocatedTco2e !== undefined : true), {
    message: "allocatedTco2e is required for this allocation method",
    path: ["allocatedTco2e"],
  })
  .refine((v) => (v.allocationMethod === "spend_share" ? v.supplierRevenueGbp !== undefined : true), {
    message: "supplierRevenueGbp is required for a spend share",
    path: ["supplierRevenueGbp"],
  });
export type EmissionsReportCreate = z.infer<typeof emissionsReportCreateSchema>;

export const emissionsReportUpdateSchema = z.object({
  periodStart: isoDate.optional(),
  periodEnd: isoDate.optional(),
  scope1Tco2e: optionalNumber.pipe(z.number().nonnegative().optional()),
  scope2LocationTco2e: optionalNumber.pipe(z.number().nonnegative().optional()),
  scope2MarketTco2e: optionalNumber.pipe(z.number().nonnegative().optional()),
  scope3Tco2e: optionalNumber.pipe(z.number().nonnegative().optional()),
  allocationMethod: z.enum(ALLOCATION_METHODS).optional(),
  allocatedTco2e: optionalNumber.pipe(z.number().nonnegative().optional()),
  supplierRevenueGbp: optionalNumber.pipe(z.number().positive().optional()),
  methodology: z.enum(METHODOLOGIES).optional(),
  boundary: z.enum(BOUNDARIES).optional(),
  assurance: z.enum(ASSURANCE_LEVELS).optional(),
  assuranceProvider: optionalText(120),
  basis: z.enum(REPORT_BASES).optional(),
  evidence: optionalText(300),
  documentDate: isoDate.optional(),
  notes: optionalText(2000),
});
export type EmissionsReportUpdate = z.infer<typeof emissionsReportUpdateSchema>;

export interface EmissionsReportRecord extends EmissionsReportCreate {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* activity ledger                                                     */
/* ------------------------------------------------------------------ */

export const ACTIVITY_BASES = ["measured", "estimated", "supplier_declared"] as const;

export const activityCreateSchema = z
  .object({
    counterpartyId: z.string().min(1),
    reportingYear: year,
    label: z.string().min(1).max(200),
    /** What the line is: electricity, natural gas, diesel, HGV tonne-km, waste to landfill. Free text; the factor row is what converts it. */
    activityType: z.string().min(1).max(120),
    periodStart: isoDate,
    periodEnd: isoDate,
    quantity: z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : Number(v)), z.number().nonnegative()),
    unit: z.string().min(1).max(40),
    factorId: optionalText(40),
    factorYear: optionalNumber.pipe(z.number().int().min(2000).max(2100).optional()),
    /** kgCO2e the counterparty already calculated for the line, used only when no factor row is chosen. */
    declaredKgCo2e: optionalNumber.pipe(z.number().nonnegative().optional()),
    /** Share of the line attributable to us, 0-100. A line for activity done wholly on our account is 100. */
    sharePct: optionalNumber.pipe(z.number().min(0).max(100).optional()).transform((v) => v ?? 100),
    basis: z.enum(ACTIVITY_BASES).default("supplier_declared"),
    evidence: optionalText(300),
    notes: optionalText(1000),
  })
  .refine((v) => v.periodEnd >= v.periodStart, { message: "periodEnd must not be before periodStart", path: ["periodEnd"] })
  .refine((v) => (v.factorId ? v.factorYear !== undefined : true), { message: "factorYear is required when a factor is chosen", path: ["factorYear"] });
export type ActivityCreate = z.infer<typeof activityCreateSchema>;

export interface ActivityRecord extends ActivityCreate {
  id: string;
  createdAt: string;
  updatedAt: string;
}
