/**
 * Fills the database with a worked Scope 3 example so the value chain pages
 * have something to show.
 *
 *   pnpm seed:demo [--reset]
 *
 * The company is Harbourside Foods Ltd, a mid-sized UK food manufacturer and
 * distributor: fifteen counterparties across both directions, two reporting
 * years, a baseline and a restatement, all fifteen categories assessed, two
 * targets with a pipeline behind them, and an open supplier link.
 *
 * It is written to exercise the awkward cases rather than the flattering ones,
 * because a demo where everything lines up teaches nothing:
 *
 *   - a counterparty that moved from a spend estimate to its own report, so
 *     the headline change and the like-for-like change differ;
 *   - one that joined the register and one that left it;
 *   - one with no annual value, which cannot be screened at all;
 *   - a decline, an unreachable, and an overdue chase;
 *   - a category excluded while counterparties are still registered
 *     against it, which the completeness check is meant to catch;
 *   - a pipeline that does not cover the gap to target.
 *
 * Writing to an existing database is refused unless --reset is passed, so it
 * cannot quietly overwrite real work.
 */
import { getDb, type Db } from "../src/lib/db/sqlite";
import {
  BaselineRepository,
  CategoryAssessmentRepository,
  CounterpartyRepository,
  EmissionsReportRepository,
  EngagementRepository,
  InitiativeRepository,
  RestatementRepository,
  SubmissionLinkRepository,
  TargetRepository,
  transition,
  type CounterpartyCreate,
  type CounterpartyRecord,
  type EmissionsReportCreate,
  type EngagementActionInput,
} from "../src/lib/value-chain";

const BASE_YEAR = 2024;
const CURRENT_YEAR = 2025;

const reset = process.argv.slice(2).includes("--reset");

/* ------------------------------------------------------------------ */
/* the register                                                        */
/* ------------------------------------------------------------------ */

interface Seed {
  counterparty: CounterpartyCreate;
  /** Reports by reporting year. A year with no entry means nothing came back. */
  reports?: Partial<Record<number, Omit<EmissionsReportCreate, "counterpartyId" | "reportingYear" | "periodStart" | "periodEnd">>>;
  /** Engagement actions applied in order for the current year. */
  chase?: EngagementActionInput["action"][];
  declineReason?: string;
  /** Retired from the register after the base year, so it shows as "left". */
  leftAfterBaseYear?: boolean;
  /** Not on the register in the base year, so it shows as "joined". */
  joinedThisYear?: boolean;
}

const SEEDS: Seed[] = [
  {
    counterparty: {
      name: "Bidfood Ltd", sector: "Food wholesale", country: "GB", roles: ["supplier", "distributor"], ghgCategories: [],
      annualValueGbp: 2_400_000, contactName: "Priya Raman", contactEmail: "priya.raman@example.com",
      escalationName: "Alan Whitfield", escalationEmail: "alan.whitfield@example.com",
      ask: "annual_ghg_report", status: "active",
      notes: "Largest single line of spend. Publishes a full inventory with limited assurance.",
    },
    reports: {
      [BASE_YEAR]: { scope1Tco2e: 12_400, scope2LocationTco2e: 8_900, scope3Tco2e: 410_000, allocationMethod: "spend_share", supplierRevenueGbp: 3_600_000_000, methodology: "ghg_protocol", boundary: "operational_control", assurance: "limited", assuranceProvider: "Carbon Assurance LLP", basis: "supplier_reported", evidence: "Sustainability Report 2024, p.41", documentDate: "2025-03-18" },
      [CURRENT_YEAR]: { scope1Tco2e: 11_600, scope2LocationTco2e: 7_450, scope3Tco2e: 388_000, allocationMethod: "spend_share", supplierRevenueGbp: 3_710_000_000, methodology: "ghg_protocol", boundary: "operational_control", assurance: "limited", assuranceProvider: "Carbon Assurance LLP", basis: "supplier_reported", evidence: "Sustainability Report 2025, p.44", documentDate: "2026-03-11" },
    },
    chase: ["request_sent", "reply_received", "data_received", "marked_complete", "verified"],
  },
  {
    counterparty: {
      name: "Northern Dairy Co-operative", sector: "Dairy processing", country: "GB", roles: ["supplier"], ghgCategories: [],
      annualValueGbp: 1_150_000, contactName: "Fiona Elliot", contactEmail: "f.elliot@example.com",
      ask: "annual_ghg_report", status: "active",
      notes: "Agricultural emissions dominate their inventory; figures move with herd size.",
    },
    reports: {
      [BASE_YEAR]: { scope1Tco2e: 44_000, scope2LocationTco2e: 3_100, scope3Tco2e: 96_000, allocationMethod: "spend_share", supplierRevenueGbp: 412_000_000, methodology: "ghg_protocol", boundary: "operational_control", assurance: "none", basis: "supplier_reported", evidence: "Annual GHG statement 2024", documentDate: "2025-04-02" },
      [CURRENT_YEAR]: { scope1Tco2e: 45_800, scope2LocationTco2e: 2_950, scope3Tco2e: 99_500, allocationMethod: "spend_share", supplierRevenueGbp: 428_000_000, methodology: "ghg_protocol", boundary: "operational_control", assurance: "none", basis: "supplier_reported", evidence: "Annual GHG statement 2025", documentDate: "2026-04-07" },
    },
    chase: ["request_sent", "reply_received", "data_received", "marked_complete"],
  },
  {
    // The rebasing case: a spend estimate last year, their own report this
    // year. The attributable figure falls, but none of that is abatement.
    counterparty: {
      name: "Clearwater Packaging Ltd", sector: "Packaging manufacture", country: "GB", roles: ["supplier"], ghgCategories: [],
      annualValueGbp: 780_000, contactName: "Dan Mercer", contactEmail: "d.mercer@example.com",
      ask: "annual_ghg_report", status: "active",
      spendFactorKgCo2ePerGbp: 0.42, spendFactorSource: "DESNZ 2024 indirect emissions by SIC, paper and packaging",
      notes: "Was a tier D spend estimate until they published for the first time in 2025.",
    },
    reports: {
      [CURRENT_YEAR]: { scope1Tco2e: 1_850, scope2LocationTco2e: 2_400, scope3Tco2e: 18_600, allocationMethod: "spend_share", supplierRevenueGbp: 96_000_000, methodology: "iso_14064", boundary: "operational_control", assurance: "none", basis: "supplier_reported", evidence: "First carbon disclosure, issued 2026-02", documentDate: "2026-02-20" },
    },
    chase: ["request_sent", "reply_received", "data_received", "marked_complete"],
  },
  {
    counterparty: {
      name: "GridServe Energy Supply", sector: "Electricity supply", country: "GB", roles: ["energy_supplier"], ghgCategories: [],
      annualValueGbp: 640_000, contactName: "Helen Mbeki", contactEmail: "helen.mbeki@example.com",
      ask: "annual_ghg_report", status: "active",
      notes: "Category 3 well-to-tank and T&D losses on our purchased electricity.",
    },
    reports: {
      [BASE_YEAR]: { scope1Tco2e: 900, scope2LocationTco2e: 140, scope3Tco2e: 62_000, allocationMethod: "spend_share", supplierRevenueGbp: 840_000_000, methodology: "ghg_protocol", boundary: "financial_control", assurance: "reasonable", assuranceProvider: "Deloitte", basis: "supplier_reported", evidence: "ESG datapack 2024", documentDate: "2025-02-28" },
      [CURRENT_YEAR]: { scope1Tco2e: 870, scope2LocationTco2e: 120, scope3Tco2e: 54_500, allocationMethod: "spend_share", supplierRevenueGbp: 905_000_000, methodology: "ghg_protocol", boundary: "financial_control", assurance: "reasonable", assuranceProvider: "Deloitte", basis: "supplier_reported", evidence: "ESG datapack 2025", documentDate: "2026-02-25" },
    },
    chase: ["request_sent", "reply_received", "data_received", "marked_complete", "verified"],
  },
  {
    // Joined the register this year: new haulage contract from April.
    counterparty: {
      name: "Kingsley Logistics", sector: "Road haulage", country: "GB", roles: ["logistics"], ghgCategories: [],
      annualValueGbp: 520_000, contactName: "Ray Poulter", contactEmail: "r.poulter@example.com",
      ask: "annual_ghg_report", status: "active",
      notes: "Contract began April 2025, so there is no base year figure to compare against.",
    },
    reports: {
      [CURRENT_YEAR]: { scope1Tco2e: 9_600, scope2LocationTco2e: 310, scope3Tco2e: 4_200, allocationMethod: "spend_share", supplierRevenueGbp: 74_000_000, methodology: "ghg_protocol", boundary: "operational_control", assurance: "none", basis: "supplier_reported", evidence: "Emailed GHG summary", documentDate: "2026-05-14" },
    },
    chase: ["request_sent", "reply_received", "data_received", "marked_complete"],
    joinedThisYear: true,
  },
  {
    // Left the register: contract ended, so its base year figure has to come
    // out of the like-for-like comparison rather than read as a reduction.
    counterparty: {
      name: "Penrose Seafood Ltd", sector: "Seafood processing", country: "GB", roles: ["supplier"], ghgCategories: [],
      annualValueGbp: 690_000, contactName: "Morwenna Hale", contactEmail: "m.hale@example.com",
      ask: "annual_ghg_report", status: "inactive",
      notes: "Supply contract ended December 2024. Retained for the base year comparison.",
    },
    reports: {
      [BASE_YEAR]: { scope1Tco2e: 6_300, scope2LocationTco2e: 1_900, scope3Tco2e: 41_000, allocationMethod: "spend_share", supplierRevenueGbp: 58_000_000, methodology: "ghg_protocol", boundary: "operational_control", assurance: "none", basis: "supplier_reported", evidence: "GHG statement 2024", documentDate: "2025-05-06" },
    },
    leftAfterBaseYear: true,
  },
  {
    // Spend estimate only, both years: the honest tier D case.
    counterparty: {
      name: "Bramble Waste Services", sector: "Waste management", country: "GB", roles: ["waste_contractor"], ghgCategories: [],
      annualValueGbp: 96_000, contactName: "Terry Boyd", contactEmail: "t.boyd@example.com",
      ask: "either", status: "active",
      spendFactorKgCo2ePerGbp: 0.61, spendFactorSource: "DESNZ 2024 indirect emissions by SIC, waste collection and treatment",
      notes: "No inventory of their own. Asked for an activity ledger instead; tonnage by treatment route.",
    },
    chase: ["request_sent", "reminder_sent", "reminder_sent"],
  },
  {
    counterparty: {
      name: "Corporate Travel Partners", sector: "Travel management", country: "GB", roles: ["travel_provider"], ghgCategories: [],
      annualValueGbp: 210_000, contactName: "Sasha Lindqvist", contactEmail: "s.lindqvist@example.com",
      ask: "activity_ledger", status: "active",
      notes: "Booking data is available through the portal, but they will not disclose their own footprint.",
    },
    chase: ["request_sent", "reminder_sent", "declined"],
    declineReason: "commercially_sensitive",
  },
  {
    counterparty: {
      name: "Meridian Estates LLP", sector: "Property", country: "GB", roles: ["landlord"], ghgCategories: [],
      annualValueGbp: 340_000, contactName: "(no named contact)", contactEmail: "info@example.com",
      ask: "annual_ghg_report", status: "active",
      notes: "Landlord of the Avonmouth cold store. No reply to three approaches; escalate through the lease.",
    },
    chase: ["request_sent", "reminder_sent", "reminder_sent", "escalated", "unreachable"],
  },
  {
    // No annual value: cannot be ranked or estimated. Shows as unscreenable
    // rather than being quietly sorted to the bottom.
    counterparty: {
      name: "Vale Print & Labels", sector: "Print", country: "GB", roles: ["supplier"], ghgCategories: [],
      contactName: "Jo Bannerman", contactEmail: "jo@example.com",
      ask: "annual_ghg_report", status: "active",
      notes: "Spend sits under a shared marketing cost centre and has never been split out.",
    },
    chase: ["request_sent"],
  },
  {
    counterparty: {
      name: "Saltmarsh Retail Group", sector: "Grocery retail", country: "GB", roles: ["customer"], ghgCategories: [],
      annualValueGbp: 3_200_000, contactName: "Neil Ardagh", contactEmail: "n.ardagh@example.com",
      ask: "annual_ghg_report", status: "active",
      notes: "Our largest customer. They also send us a category 1 request each year, answered from the inbox.",
    },
    reports: {
      [BASE_YEAR]: { scope1Tco2e: 28_000, scope2LocationTco2e: 61_000, scope3Tco2e: 2_100_000, allocationMethod: "supplier_allocated", allocatedTco2e: 3_180, methodology: "ghg_protocol", boundary: "operational_control", assurance: "limited", assuranceProvider: "KPMG", basis: "supplier_reported", evidence: "Supplier portal export 2024", documentDate: "2025-06-12" },
      [CURRENT_YEAR]: { scope1Tco2e: 26_400, scope2LocationTco2e: 52_000, scope3Tco2e: 2_040_000, allocationMethod: "supplier_allocated", allocatedTco2e: 2_910, methodology: "ghg_protocol", boundary: "operational_control", assurance: "limited", assuranceProvider: "KPMG", basis: "supplier_reported", evidence: "Supplier portal export 2025", documentDate: "2026-06-09" },
    },
    chase: ["request_sent", "reply_received", "data_received", "marked_complete", "verified"],
  },
  {
    counterparty: {
      name: "Harbour View Cafés Ltd", sector: "Food service", country: "GB", roles: ["franchisee"], ghgCategories: [],
      annualValueGbp: 180_000, contactName: "Ivy Chandler", contactEmail: "ivy@example.com",
      ask: "activity_ledger", status: "active",
      spendFactorKgCo2ePerGbp: 0.33, spendFactorSource: "DESNZ 2024 indirect emissions by SIC, food and beverage service",
      notes: "Eleven outlets under franchise. Meter readings come in per site; no inventory of their own.",
    },
    chase: ["request_sent", "reply_received"],
  },
  {
    counterparty: {
      name: "Quay Street Units Ltd", sector: "Property", country: "GB", roles: ["tenant"], ghgCategories: [],
      annualValueGbp: 210_000, contactName: "Martin Oyelaran", contactEmail: "m.oyelaran@example.com",
      ask: "activity_ledger", status: "active",
      spendFactorKgCo2ePerGbp: 0.28, spendFactorSource: "DESNZ 2024 indirect emissions by SIC, real estate",
      notes: "Sublet units at the Bristol site. Green lease clause obliges them to share meter data.",
    },
    chase: ["request_sent", "reminder_sent"],
  },
  {
    counterparty: {
      name: "Ferndale Capital Goods", sector: "Industrial equipment", country: "GB", roles: ["capital_supplier"], ghgCategories: [],
      annualValueGbp: 430_000, contactName: "Gus Rainford", contactEmail: "g.rainford@example.com",
      ask: "annual_ghg_report", status: "active",
      spendFactorKgCo2ePerGbp: 0.55, spendFactorSource: "DESNZ 2024 indirect emissions by SIC, machinery and equipment",
      notes: "Chillers and line equipment. Category 2 only; replacement cycle is roughly seven years.",
    },
    chase: ["request_sent", "reminder_sent"],
  },
  {
    counterparty: {
      name: "Atlas Ingredients GmbH", sector: "Food ingredients", country: "DE", roles: ["supplier"], ghgCategories: [],
      annualValueGbp: 505_000, contactName: "Katrin Vogel", contactEmail: "k.vogel@example.com",
      ask: "annual_ghg_report", status: "active",
      spendFactorKgCo2ePerGbp: 0.47, spendFactorSource: "DESNZ 2024 indirect emissions by SIC, food manufacturing",
      notes: "CSRD-reporting parent, so a full inventory should be obtainable. First ask went out late.",
    },
    chase: ["request_sent"],
  },
];

/* ------------------------------------------------------------------ */
/* the fifteen categories                                              */
/* ------------------------------------------------------------------ */

type Assessment = { category: string; relevance: "relevant" | "not_relevant" | "not_yet_assessed"; status: "calculated" | "estimated" | "excluded" | "not_started"; justification: string; method?: string };

const ASSESSMENTS: Assessment[] = [
  { category: "1", relevance: "relevant", status: "calculated", justification: "Largest category by a wide margin. Supplier reports cover 71 per cent of spend; the remainder is a disclosed spend estimate.", method: "Supplier-reported inventories allocated by revenue share, spend factors elsewhere." },
  { category: "2", relevance: "relevant", status: "estimated", justification: "Chillers, line equipment and vehicles. No supplier inventory yet, so a spend-based estimate is used and disclosed as tier D.", method: "DESNZ indirect emissions by SIC applied to capitalised spend." },
  { category: "3", relevance: "relevant", status: "calculated", justification: "Well-to-tank and transmission losses on purchased electricity and gas, taken from the energy supplier's own disclosure.", method: "Supplier WTT and T&D factors applied to metered consumption." },
  { category: "4", relevance: "relevant", status: "calculated", justification: "Inbound haulage under the Kingsley contract from April 2025; before that it was carried in supplier pricing and reported under category 1.", method: "Haulier-reported tonne-km." },
  { category: "5", relevance: "relevant", status: "estimated", justification: "Waste contractor holds no inventory. Estimated from tonnage by treatment route pending the activity ledger they have been asked for.", method: "DESNZ waste factors by treatment route." },
  { category: "6", relevance: "relevant", status: "calculated", justification: "Booking data comes through the travel management platform even though the provider will not disclose its own footprint.", method: "DESNZ business travel factors applied to booked distance by mode and class." },
  { category: "7", relevance: "relevant", status: "estimated", justification: "Estimated from the 2025 staff travel survey and postcode distances. A survey is not a measurement and is marked as an estimate.", method: "Survey response rate 38 per cent, grossed to headcount." },
  { category: "8", relevance: "relevant", status: "not_started", justification: "The Avonmouth cold store is leased and material, but the landlord has not responded to three approaches. Escalation through the lease is in hand.", },
  { category: "9", relevance: "relevant", status: "estimated", justification: "Outbound distribution to retail depots. Estimated from delivery manifests until the carrier provides its own figures.", method: "Tonne-km from manifests against DESNZ HGV factors." },
  { category: "10", relevance: "not_relevant", status: "excluded", justification: "Products are shipped ready to eat or ready to heat. No further industrial processing occurs downstream, so there are no processing emissions to report.", },
  { category: "11", relevance: "relevant", status: "estimated", justification: "Chilled and frozen lines require refrigeration and, for part of the range, cooking by the consumer. Estimated on a use-phase model; the assumptions are the weakest part of the inventory.", method: "Use-phase model over assumed storage days and cooking energy." },
  { category: "12", relevance: "relevant", status: "calculated", justification: "Packaging placed on the market is known exactly from the packaging waste return, so end-of-life is calculated rather than estimated.", method: "Packaging tonnage by material against DESNZ end-of-life factors." },
  { category: "13", relevance: "relevant", status: "estimated", justification: "Sublet units at the Bristol site. Estimated from floor area until the tenant supplies meter data under the green lease clause.", method: "Floor-area intensity benchmark pending actual readings." },
  { category: "14", relevance: "relevant", status: "estimated", justification: "Eleven franchised cafés. Estimated from site-level meter readings where supplied and from floor area elsewhere.", method: "Meter readings where available, benchmark elsewhere." },
  { category: "15", relevance: "not_relevant", status: "excluded", justification: "The company holds no equity investments, no debt investments and no project finance. There is nothing in this category to report.", },
];

/* ------------------------------------------------------------------ */

function main() {
  const db = getDb();
  guardExistingData(db);

  const counterparties = new CounterpartyRepository(db);
  const engagements = new EngagementRepository(db);
  const reports = new EmissionsReportRepository(db);

  const created: { seed: Seed; record: CounterpartyRecord }[] = [];
  for (const seed of SEEDS) {
    const record = counterparties.create(seed.counterparty);
    created.push({ seed, record });

    for (const [yearText, report] of Object.entries(seed.reports ?? {})) {
      if (!report) continue;
      const year = Number(yearText);
      reports.create({
        ...report,
        counterpartyId: record.id,
        reportingYear: year,
        periodStart: `${year}-01-01`,
        periodEnd: `${year}-12-31`,
      });
    }
  }

  // Engagements for both years. The base year is closed out; the current year
  // is mid-chase, which is what the inbox and the ranked plan are for.
  for (const { seed, record } of created) {
    if (!seed.joinedThisYear) applyChase(engagements, record, BASE_YEAR, seed.reports?.[BASE_YEAR] ? ["request_sent", "reply_received", "data_received", "marked_complete", "verified"] : ["request_sent", "reminder_sent"], seed.declineReason);
    if (!seed.leftAfterBaseYear && seed.chase) applyChase(engagements, record, CURRENT_YEAR, seed.chase, seed.declineReason);
  }

  new BaselineRepository(db).set({
    baselineYear: BASE_YEAR,
    rationale: "First year with supplier-reported data across more than half of spend. Earlier years were spend estimates throughout and would not support a reduction claim.",
    setOn: `${BASE_YEAR + 1}-06-30`,
    notes: "Recut if the register changes by more than ten per cent of value in any one year.",
  });

  new RestatementRepository(db).create({
    reportingYear: BASE_YEAR,
    reason: "better_data",
    detail: "Bidfood's 2024 figure was originally a spend estimate. Their published inventory arrived in March 2025 and replaced it, lowering the base year by roughly 240 tCO2e. The base year was restated rather than left inconsistent with later years.",
    previousTco2e: 5_060,
    restatedTco2e: 4_820,
    recordedOn: `${BASE_YEAR + 1}-03-25`,
  });

  const assessments = new CategoryAssessmentRepository(db);
  for (const a of ASSESSMENTS) {
    assessments.upsert({ ...a, reportingYear: CURRENT_YEAR, assessedOn: `${CURRENT_YEAR + 1}-05-30` });
  }

  const targets = new TargetRepository(db);
  targets.create({
    name: "Value chain emissions down 42 per cent by 2030",
    kind: "absolute_tco2e", baselineYear: BASE_YEAR, targetYear: 2030, targetValue: 2_800,
    status: "active", owner: "Group Sustainability",
    notes: "Aligned to a 1.5C-consistent reduction rate. Absolute, not intensity, so growth does not create headroom.",
  });
  targets.create({
    name: "Seventy per cent primary data by 2028",
    kind: "primary_share_pct", baselineYear: BASE_YEAR, targetYear: 2028, targetValue: 70,
    status: "active", owner: "Group Sustainability",
    notes: "Primary means tiers A and B: the counterparty's own reported figure, not a spend estimate.",
  });

  const initiatives = new InitiativeRepository(db);
  const byName = (name: string) => created.find((c) => c.record.name === name)?.record.id;
  initiatives.create({
    name: "Move ambient haulage to the Kingsley electric fleet", lever: "logistics", category: "4",
    status: "in_progress", expectedAnnualTco2e: 310, expectedFromYear: 2027, costGbp: 48_000,
    owner: "Logistics", counterpartyId: byName("Kingsley Logistics"),
    notes: "Depot charging is the constraint, not vehicle availability.",
  });
  initiatives.create({
    name: "Lightweight the 500g tray by 18 per cent", lever: "specification_change", category: "1",
    status: "delivered", expectedAnnualTco2e: 140, expectedFromYear: 2025, actualAnnualTco2e: 96, actualFromYear: 2025,
    costGbp: 22_000, owner: "Packaging", counterpartyId: byName("Clearwater Packaging Ltd"),
    evidence: "Packaging spec change note PK-2025-11",
    notes: "Delivered under expectation: the thinner tray failed drop testing at first and the saving was cut back.",
  });
  initiatives.create({
    name: "Northern Dairy to set a science-based target", lever: "supplier_decarbonisation", category: "1",
    status: "agreed", expectedAnnualTco2e: 220, expectedFromYear: 2028,
    owner: "Procurement", counterpartyId: byName("Northern Dairy Co-operative"),
    notes: "Commitment letter signed. Nothing lands until their own programme starts.",
  });
  initiatives.create({
    name: "Switch the Avonmouth cold store to a REGO-backed supply", lever: "contractual", category: "3",
    status: "proposed", expectedAnnualTco2e: 180, expectedFromYear: 2027,
    owner: "Energy",
    notes: "Proposed only, so it is not counted in the pipeline. A market-based claim does not change the location-based figure.",
  });
  initiatives.create({
    name: "Cut air freight on ingredient shortfalls", lever: "volume_reduction", category: "4",
    status: "stalled", expectedAnnualTco2e: 75, expectedFromYear: 2026,
    owner: "Supply chain",
    notes: "Stalled: without more buffer stock the shortfalls still have to be flown.",
  });

  // One open invitation so the supplier-facing page can be opened without
  // issuing a link by hand. The token is printed once and stored only hashed.
  const links = new SubmissionLinkRepository(db);
  const atlas = byName("Atlas Ingredients GmbH");
  let token: string | undefined;
  if (atlas) {
    const issued = links.create({ counterpartyId: atlas, reportingYear: CURRENT_YEAR, ask: "annual_ghg_report", validForDays: 30, createdBy: "demo seed" });
    token = issued.token;
  }

  report(db, created.length, token);
}

function applyChase(
  engagements: EngagementRepository,
  counterparty: CounterpartyRecord,
  year: number,
  actions: EngagementActionInput["action"][],
  declineReason?: string,
): void {
  let engagement = engagements.ensure(counterparty.id, year, counterparty.ask);
  // Spread the chase back from today so due dates and reminder gaps look real.
  let offset = actions.length * 24;
  for (const action of actions) {
    const at = daysAgo(offset);
    const input: EngagementActionInput = {
      reportingYear: year,
      action,
      on: at,
      channel: "email",
      actor: "demo",
      ...(action === "declined" ? { declineReason: declineReason ?? "commercially_sensitive" } : {}),
      ...(action === "request_sent" ? { dueOn: addDays(at, 30) } : {}),
    };
    const patch = transition(engagement, input, at);
    engagement = engagements.applyTransition(engagement, patch, { action, at, channel: "email", actor: "demo" }).engagement;
    offset -= 24;
  }
}

function guardExistingData(db: Db): void {
  const existing = (db.prepare("SELECT COUNT(*) AS n FROM counterparties").get() as { n: number }).n;
  if (existing === 0) return;
  if (!reset) {
    console.error(`Refusing to seed: the database already holds ${existing} counterparties.`);
    console.error("Pass --reset to clear the value chain tables first, or point DB_PATH at a scratch file.");
    process.exit(1);
  }
  for (const table of [
    "supplier_submission_links", "abatement_initiatives", "value_chain_targets", "scope3_category_assessments",
    "value_chain_restatements", "value_chain_baseline", "counterparty_activity", "counterparty_emissions",
    "counterparty_engagement_events", "counterparty_engagements", "counterparties",
  ]) {
    try { db.exec(`DELETE FROM ${table}`); } catch { /* table may not exist in an older database */ }
  }
  console.log("Cleared the existing value chain data.");
}

function report(db: Db, count: number, token: string | undefined): void {
  const engagements = (db.prepare("SELECT COUNT(*) AS n FROM counterparty_engagements").get() as { n: number }).n;
  const reports = (db.prepare("SELECT COUNT(*) AS n FROM counterparty_emissions").get() as { n: number }).n;
  console.log(`\nHarbourside Foods Ltd seeded: ${count} counterparties, ${engagements} engagements, ${reports} emissions reports.`);
  console.log(`Baseline ${BASE_YEAR}, current year ${CURRENT_YEAR}, all fifteen categories assessed, 2 targets, 5 initiatives.\n`);
  console.log("Start the portal and open:");
  console.log("  /value-chain              the register, coverage and the ranked chase plan");
  console.log(`  /value-chain/trend        ${BASE_YEAR} against ${CURRENT_YEAR}: headline versus like-for-like`);
  console.log("  /value-chain/hotspots     where the emissions are, and who cannot be screened");
  console.log("  /value-chain/completeness all fifteen categories, two excluded with reasons");
  console.log("  /value-chain/targets      progress against the trajectory, and the pipeline behind the gap");
  if (token) {
    console.log(`\nOpen supplier link (Atlas Ingredients GmbH, ${CURRENT_YEAR}), shown once:`);
    console.log(`  /value-chain/submit/${token}`);
  }
  console.log("");
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

main();
