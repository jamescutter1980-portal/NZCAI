import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "@/lib/db/sqlite";
import { calendarYear } from "@/lib/carbon/period";
import { routedFetch, testContext } from "@/lib/integrations/testing";
import {
  BaselineRepository,
  CategoryAssessmentRepository,
  CounterpartyRepository,
  EmissionsReportRepository,
  InitiativeRepository,
  RestatementRepository,
  SubmissionLinkError,
  SubmissionLinkRepository,
  TargetRepository,
  acceptSubmission,
  categoryCompleteness,
  initiativeCreateSchema,
  hotspotScreen,
  openInvitation,
  receiveSubmission,
  targetReport,
  valueChainReport,
  valueChainTrend,
} from "..";

const DESNZ_CSV = `ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,GHG Conversion Factor 2025
1,Scope 2,UK electricity,Electricity generated,,,,kWh,kg CO2e,0.200
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "value-chain-analysis-"));
  mkdirSync(join(dir, "desnz-conversion-factors"), { recursive: true });
  writeFileSync(join(dir, "desnz-conversion-factors", "2025.csv"), DESNZ_CSV);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date("2026-06-01T00:00:00Z");
const ctx = () => testContext(routedFetch([]), { REFERENCE_DATA_DIR: dir }, NOW);

const reportBase = {
  methodology: "ghg_protocol" as const,
  boundary: "operational_control" as const,
  assurance: "none" as const,
  basis: "supplier_reported" as const,
  evidence: "2025 report p.14",
};

/** A counterparty whose whole footprint is attributed, so the arithmetic is easy to read. */
function wholeFootprint(db: Db, name: string, year: number, tco2e: number, opts: { annualValueGbp?: number } = {}) {
  const counterparties = new CounterpartyRepository(db);
  const existing = counterparties.findByName(name);
  const c = existing ?? counterparties.create({ name, roles: ["supplier"], ask: "annual_ghg_report", status: "active", annualValueGbp: opts.annualValueGbp ?? 1_000_000 });
  new EmissionsReportRepository(db).create({
    ...reportBase,
    counterpartyId: c.id,
    reportingYear: year,
    periodStart: `${year}-01-01`,
    periodEnd: `${year}-12-31`,
    scope1Tco2e: tco2e,
    allocationMethod: "supplier_total",
  });
  return c;
}

describe("valueChainTrend", () => {
  it("separates like-for-like movement from counterparties entering and leaving", () => {
    const db = openDatabase(":memory:");
    // Stays in both years and falls 100 -> 80.
    wholeFootprint(db, "Steady Ltd", 2024, 100);
    wholeFootprint(db, "Steady Ltd", 2025, 80);
    // Only in 2024: leaving the register is not a reduction.
    wholeFootprint(db, "Departed Ltd", 2024, 50);
    // Only in 2025: an arrival is not an increase in real emissions.
    wholeFootprint(db, "Arrived Ltd", 2025, 30);

    const t = valueChainTrend(db, ctx(), calendarYear(2025), { years: [2024, 2025] });
    const yoy = t.yearOnYear[0];

    expect(yoy.headline.fromTco2e).toBe(150);
    expect(yoy.headline.toTco2e).toBe(110);
    expect(yoy.likeForLike.counterparties).toBe(1);
    expect(yoy.likeForLike.fromTco2e).toBe(100);
    expect(yoy.likeForLike.toTco2e).toBe(80);
    expect(yoy.likeForLike.changePct).toBe(-20);
    expect(yoy.entered.map((e) => e.name)).toEqual(["Arrived Ltd"]);
    expect(yoy.left.map((e) => e.name)).toEqual(["Departed Ltd"]);
    expect(yoy.warnings.join(" ")).toContain("not like for like");
  });

  it("holds a counterparty out of the like-for-like figure when the basis changed", () => {
    const db = openDatabase(":memory:");
    const counterparties = new CounterpartyRepository(db);
    // 2024: nothing returned, so a tier D spend estimate stands in.
    const c = counterparties.create({
      name: "Rebased Ltd",
      roles: ["supplier"],
      ask: "annual_ghg_report",
      status: "active",
      annualValueGbp: 1_000_000,
      spendFactorKgCo2ePerGbp: 0.2,
      spendFactorSource: "sector average",
    });
    // 2025: a real report arrives.
    new EmissionsReportRepository(db).create({
      ...reportBase,
      counterpartyId: c.id,
      reportingYear: 2025,
      periodStart: "2025-01-01",
      periodEnd: "2025-12-31",
      scope1Tco2e: 150,
      allocationMethod: "supplier_total",
    });

    const t = valueChainTrend(db, ctx(), calendarYear(2025), { years: [2024, 2025] });
    const yoy = t.yearOnYear[0];

    expect(yoy.rebased.map((r) => r.name)).toEqual(["Rebased Ltd"]);
    expect(yoy.moved).toEqual([]);
    expect(yoy.likeForLike.counterparties).toBe(0);
    expect(yoy.rebased[0].detail).toContain("measurement change");
    expect(yoy.warnings.join(" ")).toContain("not abatement");
  });

  it("measures against the baseline year and warns when none is set", () => {
    const db = openDatabase(":memory:");
    wholeFootprint(db, "Steady Ltd", 2023, 200);
    wholeFootprint(db, "Steady Ltd", 2025, 100);

    const without = valueChainTrend(db, ctx(), calendarYear(2025), { years: [2023, 2025] });
    expect(without.vsBaseline).toBeUndefined();
    expect(without.warnings.join(" ")).toContain("No baseline year is set");

    new BaselineRepository(db).set({ baselineYear: 2023, rationale: "First year with audited supplier data.", setOn: "2024-01-15" });
    const withBaseline = valueChainTrend(db, ctx(), calendarYear(2025), { years: [2023, 2025] });
    expect(withBaseline.vsBaseline?.changePct).toBe(-50);
    expect(withBaseline.vsBaseline?.baselineYear).toBe(2023);
  });

  it("flags a restated baseline so the comparison is not read as first published", () => {
    const db = openDatabase(":memory:");
    wholeFootprint(db, "Steady Ltd", 2023, 200);
    wholeFootprint(db, "Steady Ltd", 2025, 100);
    new BaselineRepository(db).set({ baselineYear: 2023, rationale: "First complete year.", setOn: "2024-01-15" });
    new RestatementRepository(db).create({
      reportingYear: 2023,
      reason: "better_data",
      detail: "Two suppliers replaced spend estimates with reported figures.",
      previousTco2e: 180,
      restatedTco2e: 200,
      recordedOn: "2025-02-01",
    });

    const t = valueChainTrend(db, ctx(), calendarYear(2025), { years: [2023, 2025] });
    expect(t.warnings.join(" ")).toContain("restatement");
    expect(t.years.find((y) => y.reportingYear === 2023)?.restatements).toHaveLength(1);
  });
});

describe("categoryCompleteness", () => {
  it("treats an unassessed category as a gap rather than a zero", () => {
    const db = openDatabase(":memory:");
    wholeFootprint(db, "Steady Ltd", 2025, 100);
    const r = categoryCompleteness(db, valueChainReport(db, ctx(), calendarYear(2025)));

    expect(r.lines).toHaveLength(15);
    expect(r.counts.unassessed).toBe(15);
    expect(r.complete).toBe(false);
    expect(r.lines[0].gap).toContain("never been assessed");
    expect(r.warnings.join(" ")).toContain("cannot be told apart from an oversight");
  });

  it("accepts an exclusion with a justification and rejects a thin one", () => {
    const db = openDatabase(":memory:");
    const assessments = new CategoryAssessmentRepository(db);
    assessments.upsert({
      reportingYear: 2025,
      category: "11",
      relevance: "not_relevant",
      status: "excluded",
      justification: "The company sells professional services only; no sold product consumes energy in use.",
      assessedOn: "2026-01-10",
    });
    assessments.upsert({ reportingYear: 2025, category: "12", relevance: "not_relevant", status: "excluded", justification: "n/a", assessedOn: "2026-01-10" });

    const r = categoryCompleteness(db, valueChainReport(db, ctx(), calendarYear(2025)));
    expect(r.counts.notRelevant).toBe(2);
    expect(r.counts.unjustifiedExclusions).toBe(1);
    expect(r.warnings.join(" ")).toContain("too short to stand up");
  });

  it("catches a category excluded while counterparties are registered against it", () => {
    const db = openDatabase(":memory:");
    new CounterpartyRepository(db).create({ name: "Hauler Ltd", roles: ["logistics"], ghgCategories: ["4"], ask: "annual_ghg_report", status: "active" });
    new CategoryAssessmentRepository(db).upsert({
      reportingYear: 2025,
      category: "4",
      relevance: "not_relevant",
      status: "excluded",
      justification: "All inbound freight is arranged and paid for by our customers, not by us.",
      assessedOn: "2026-01-10",
    });

    const r = categoryCompleteness(db, valueChainReport(db, ctx(), calendarYear(2025)));
    const line = r.lines.find((l) => l.category === "4")!;
    expect(line.gap).toContain("Either the exclusion or the register is wrong");
  });

  it("rolls assessments forward without overwriting answers already given", () => {
    const db = openDatabase(":memory:");
    const assessments = new CategoryAssessmentRepository(db);
    assessments.upsert({ reportingYear: 2024, category: "1", relevance: "relevant", status: "calculated", justification: "Largest single category by spend.", assessedOn: "2025-01-10" });
    assessments.upsert({ reportingYear: 2024, category: "2", relevance: "relevant", status: "estimated", justification: "Capital spend screened from the asset register.", assessedOn: "2025-01-10" });
    assessments.upsert({ reportingYear: 2025, category: "1", relevance: "relevant", status: "estimated", justification: "Supplier data not yet returned for this year.", assessedOn: "2026-01-10" });

    const carried = assessments.rollForward(2024, 2025);
    expect(carried.map((c) => c.category)).toEqual(["2"]);
    expect(assessments.find(2025, "1")?.status).toBe("estimated");
  });
});

describe("hotspotScreen", () => {
  it("ranks counterparties, marks the priority set and never blanks the ranking", () => {
    const db = openDatabase(":memory:");
    const counterparties = new CounterpartyRepository(db);
    wholeFootprint(db, "Big Ltd", 2025, 800);
    wholeFootprint(db, "Middle Ltd", 2025, 150);
    wholeFootprint(db, "Small Ltd", 2025, 50);
    // No data at all and no way to estimate: must not be ranked low, must be called out.
    counterparties.create({ name: "Opaque Ltd", roles: ["supplier"], ask: "annual_ghg_report", status: "active" });

    const screen = hotspotScreen(valueChainReport(db, ctx(), calendarYear(2025)));
    expect(screen.hotspots.map((h) => h.name)).toEqual(["Big Ltd", "Middle Ltd", "Small Ltd"]);
    expect(screen.hotspots[0].sharePct).toBe(80);
    expect(screen.hotspots[0].priority).toBe(true);
    expect(screen.hotspots[1].priority).toBe(false);
    expect(screen.totals.priorityCount).toBe(1);
    expect(screen.unscreenable.map((u) => u.name)).toEqual(["Opaque Ltd"]);
    expect(screen.warnings.join(" ")).toContain("cannot be screened at all");
  });

  it("places a counterparty with no data from spend and marks it as the engagement worklist", () => {
    const db = openDatabase(":memory:");
    new CounterpartyRepository(db).create({
      name: "Unasked Ltd",
      roles: ["supplier"],
      ask: "annual_ghg_report",
      status: "active",
      annualValueGbp: 5_000_000,
      spendFactorKgCo2ePerGbp: 0.4,
      spendFactorSource: "DESNZ input-output table",
    });

    const screen = hotspotScreen(valueChainReport(db, ctx(), calendarYear(2025)));
    expect(screen.hotspots[0].basis).toBe("spend_estimate");
    expect(screen.hotspots[0].screeningTco2e).toBe(2000); // 5m × 0.4 kg ÷ 1000
    expect(screen.totals.priorityWithoutData).toBe(1);
    expect(screen.warnings.join(" ")).toContain("engagement worklist");
  });
});

describe("targets and initiatives", () => {
  function trendFor(db: Db) {
    return valueChainTrend(db, ctx(), calendarYear(2025), { years: [2023, 2024, 2025] });
  }

  it("scores an absolute target against the straight line to its target year", () => {
    const db = openDatabase(":memory:");
    wholeFootprint(db, "Steady Ltd", 2023, 1000);
    wholeFootprint(db, "Steady Ltd", 2025, 900);
    new TargetRepository(db).create({ name: "Halve value chain emissions", kind: "absolute_tco2e", baselineYear: 2023, targetYear: 2033, targetValue: 500, status: "active" });

    const r = targetReport(db, trendFor(db));
    const p = r.progress[0];
    expect(p.baselineValue).toBe(1000);
    expect(p.latestValue).toBe(900);
    expect(p.requiredValue).toBe(900); // two years of ten, 1000 -> 500
    expect(p.onTrack).toBe(true);
    expect(p.remaining).toBe(400);
  });

  it("reports being behind the line rather than rounding it away", () => {
    const db = openDatabase(":memory:");
    wholeFootprint(db, "Steady Ltd", 2023, 1000);
    wholeFootprint(db, "Steady Ltd", 2025, 980);
    new TargetRepository(db).create({ name: "Halve value chain emissions", kind: "absolute_tco2e", baselineYear: 2023, targetYear: 2033, targetValue: 500, status: "active" });

    const r = targetReport(db, trendFor(db));
    expect(r.progress[0].onTrack).toBe(false);
    expect(r.warnings.join(" ")).toContain("behind the straight line");
  });

  it("counts only agreed initiatives in the pipeline and never nets them off measured emissions", () => {
    const db = openDatabase(":memory:");
    wholeFootprint(db, "Steady Ltd", 2023, 1000);
    wholeFootprint(db, "Steady Ltd", 2025, 900);
    new TargetRepository(db).create({ name: "Halve value chain emissions", kind: "absolute_tco2e", baselineYear: 2023, targetYear: 2033, targetValue: 500, status: "active" });
    const initiatives = new InitiativeRepository(db);
    initiatives.create({ name: "Supplier moves to certified renewable power", lever: "supplier_decarbonisation", status: "agreed", expectedAnnualTco2e: 120, expectedFromYear: 2025 });
    initiatives.create({ name: "Switch packaging to recycled board", lever: "material_substitution", status: "proposed", expectedAnnualTco2e: 300, expectedFromYear: 2026 });
    initiatives.create({ name: "Consolidate inbound deliveries", lever: "logistics", status: "delivered", expectedAnnualTco2e: 40, expectedFromYear: 2024, actualAnnualTco2e: 35, actualFromYear: 2024 });

    const r = targetReport(db, trendFor(db));
    expect(r.pipeline.expectedTco2e).toBe(160); // agreed + delivered, proposal excluded
    expect(r.pipeline.actualTco2e).toBe(35);
    expect(r.warnings.join(" ")).toContain("sits at proposed");
    // The measured figure is untouched by the pipeline.
    expect(r.progress[0].latestValue).toBe(900);
    const gap = r.gapAnalysis![0];
    expect(gap.remainingTco2e).toBe(400);
    expect(gap.shortfallTco2e).toBe(240);
    expect(gap.detail).toContain("nothing behind it");
  });

  it("refuses a delivered initiative with no achieved saving", () => {
    const parsed = initiativeCreateSchema.safeParse({ name: "Something", lever: "logistics", status: "delivered", expectedAnnualTco2e: 10, expectedFromYear: 2025 });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("actually achieved");
  });
});

describe("supplier submissions", () => {
  function linkFor(db: Db) {
    const c = new CounterpartyRepository(db).create({ name: "Bidfood Ltd", roles: ["supplier"], ask: "annual_ghg_report", status: "active" });
    return { c, ...new SubmissionLinkRepository(db).create({ counterpartyId: c.id, reportingYear: 2025, ask: "annual_ghg_report", validForDays: 30 }, NOW) };
  }
  const payload = {
    periodStart: "2025-01-01",
    periodEnd: "2025-12-31",
    scope1Tco2e: 400,
    scope2MarketTco2e: 100,
    allocationMethod: "supplier_total" as const,
    methodology: "ghg_protocol" as const,
    boundary: "operational_control" as const,
    assurance: "limited" as const,
    assuranceProvider: "Example Assurance LLP",
    basis: "supplier_reported" as const,
    evidence: "Annual report 2025 p.30",
    contactName: "A Supplier",
    contactEmail: "a@example.com",
  };

  it("stores only a hash of the token and never the token itself", () => {
    const db = openDatabase(":memory:");
    const { token, link } = linkFor(db);
    const rows = db.prepare("SELECT token_hash, token_hint FROM supplier_submission_links").all() as unknown as { token_hash: string; token_hint: string }[];
    expect(rows[0].token_hash).not.toContain(token);
    expect(token).toContain(rows[0].token_hint);
    expect(link.tokenHint).toHaveLength(4);
  });

  it("opens an invitation for a live token and refuses an unknown, revoked or expired one", () => {
    const db = openDatabase(":memory:");
    const { token, link } = linkFor(db);
    const opened = openInvitation(db, token, "2026-06-01");
    expect(opened.invitation.counterpartyName).toBe("Bidfood Ltd");
    expect(opened.invitation.instructions.join(" ")).toContain("Scope 1");

    expect(() => openInvitation(db, "not-a-real-token", "2026-06-01")).toThrow(SubmissionLinkError);
    expect(() => openInvitation(db, token, "2099-01-01")).toThrow(/expired/i);

    new SubmissionLinkRepository(db).revoke(link.id, NOW);
    expect(() => openInvitation(db, token, "2026-06-01")).toThrow(/withdrawn/i);
  });

  it("holds a submission for review rather than treating it as the reported figure", () => {
    const db = openDatabase(":memory:");
    const { token } = linkFor(db);
    receiveSubmission(db, token, payload, NOW);

    // Nothing has reached the inventory yet.
    expect(new EmissionsReportRepository(db).list({ reportingYear: 2025 })).toHaveLength(0);
    const submitted = new SubmissionLinkRepository(db).list({ state: "submitted" });
    expect(submitted).toHaveLength(1);
    expect(submitted[0].submittedPayload?.scope1Tco2e).toBe(400);
  });

  it("creates the annual report only when the client accepts, and records where it came from", () => {
    const db = openDatabase(":memory:");
    const { token } = linkFor(db);
    const link = receiveSubmission(db, token, payload, NOW);
    const { reportId } = acceptSubmission(db, link.id, NOW);

    const report = new EmissionsReportRepository(db).get(reportId)!;
    expect(report.scope1Tco2e).toBe(400);
    expect(report.assurance).toBe("limited");
    expect(report.notes).toContain("Received through a supplier link");
    expect(report.notes).toContain("A Supplier");
    expect(new SubmissionLinkRepository(db).get(link.id)?.state).toBe("accepted");
    // The link is spent.
    expect(() => openInvitation(db, token, "2026-06-01")).toThrow(/already been accepted/i);
  });

  it("refuses to accept a link nothing has been submitted against", () => {
    const db = openDatabase(":memory:");
    const { link } = linkFor(db);
    expect(() => acceptSubmission(db, link.id, NOW)).toThrow(/nothing has been submitted/i);
  });
});
