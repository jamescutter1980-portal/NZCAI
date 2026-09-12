import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "@/lib/db/sqlite";
import { calendarYear } from "@/lib/carbon/period";
import type { FetchLike } from "@/lib/integrations/framework";
import { NotConfiguredError } from "@/lib/integrations/service";
import { routedFetch, testContext } from "@/lib/integrations/testing";
import profile from "@/lib/integrations/companies-house/__tests__/fixtures/profile.json";
import { CounterpartyRepository, EngagementRepository, applyBulkAction, bulkEngagementActionSchema, counterpartyCreateSchemaChecked, resolveCounterparty, searchCandidates, spendEstimateFor, transition, valueChainReport } from "..";

const ctx = (fetch: FetchLike = routedFetch([]), env: Record<string, string> = {}) => testContext(fetch, { REFERENCE_DATA_DIR: "/nonexistent", ...env }, new Date("2026-06-01T00:00:00Z"));
const cps = (db = openDatabase(":memory:")) => ({ db, repo: new CounterpartyRepository(db) });

describe("spend-based fallback (tier D)", () => {
  it("stands in only while nothing is returned, is tier D, and never counts as returned data or primary", () => {
    const { db, repo } = cps();
    const c = repo.create({ name: "Silent Ltd", roles: ["supplier"], annualValueGbp: 400_000, ask: "annual_ghg_report", status: "active", spendFactorKgCo2ePerGbp: 0.25, spendFactorSource: "Synthetic sector factor 2024" });
    expect(spendEstimateFor(c)?.attributableTco2e).toBe(100); // 400,000 × 0.25 / 1000
    const r = valueChainReport(db, ctx(), calendarYear(2025));
    const v = r.counterparties[0];
    expect(v.dataSource).toBe("spend_estimate");
    expect(v).toMatchObject({ attributableTco2e: 100, tier: "D", primary: false });
    expect(v.warnings.join(" ")).toMatch(/estimated at tier D from spend.*Synthetic sector factor 2024/);
    expect(r.coverage).toMatchObject({ withData: 0, estimated: 1, valueCoveredPct: 0 });
    expect(r.totals).toMatchObject({ attributableTco2e: 100, returnedTco2e: 0, estimatedTco2e: 100, primarySharePct: 0, byTier: { A: 0, B: 0, C: 0, D: 1, E: 0 } });
    expect(r.totals.byCategory[0]).toMatchObject({ category: "1", withData: 0, tco2e: 100 });
    expect(r.warnings.join(" ")).toMatch(/1 counterparty is estimated from spend at tier D \(100 tCO2e of the total\)/);
    expect(v.next.action).toBe("Send the data request"); // an estimate does not stop the chase
  });

  it("is dropped the moment a ledger or report arrives, and refuses without an annual value", () => {
    const { db, repo } = cps();
    const c = repo.create({ name: "Now Answered", roles: ["supplier"], annualValueGbp: 1000, ask: "either", status: "active", spendFactorKgCo2ePerGbp: 1, spendFactorSource: "s" });
    db.prepare("INSERT INTO counterparty_activity (id, counterparty_id, reporting_year, label, activity_type, period_start, period_end, quantity, unit, declared_kgco2e, share_pct, basis, created_at, updated_at) VALUES ('l1', ?, 2025, 'x', 'x', '2025-01-01', '2025-12-31', 1, 'kWh', 500, 100, 'measured', 't', 't')").run(c.id);
    const v = valueChainReport(db, ctx(), calendarYear(2025)).counterparties[0];
    expect(v.dataSource).toBe("ledger");
    expect(v.spendEstimate).toBeUndefined();
    expect(v.attributableTco2e).toBe(0.5);

    const noValue = repo.create({ name: "No Value", roles: ["supplier"], ask: "either", status: "active", spendFactorKgCo2ePerGbp: 1, spendFactorSource: "s" });
    expect(spendEstimateFor(noValue)).toMatchObject({ attributableTco2e: null });
    expect(valueChainReport(db, ctx(), calendarYear(2025)).counterparties.find((x) => x.counterparty.id === noValue.id)).toMatchObject({ dataSource: "spend_estimate", attributableTco2e: null, tier: null });
  });

  it("requires a source for a spend factor", () => {
    expect(counterpartyCreateSchemaChecked.safeParse({ name: "X", roles: ["supplier"], spendFactorKgCo2ePerGbp: 0.2 }).success).toBe(false);
    expect(counterpartyCreateSchemaChecked.safeParse({ name: "X", roles: ["supplier"], spendFactorKgCo2ePerGbp: 0.2, spendFactorSource: "Exiobase" }).success).toBe(true);
  });
});

describe("Companies House resolution", () => {
  const env = { COMPANIES_HOUSE_API_KEY: "k" };
  const search = { total_results: 2, items: [
    { title: "FOCUS GREEN LIMITED", company_number: "12345678", company_status: "active", company_type: "ltd", date_of_creation: "2019-01-01", address_snippet: "1 Street, London" },
    { title: "FOCUS GREEN ENERGY LTD", company_number: "00000009", company_status: "dissolved", company_type: "ltd", date_of_creation: "2010-01-01", date_of_cessation: "2015-01-01", address_snippet: "x" },
  ] };

  it("proposes candidates and applies the chosen profile without overwriting what is recorded", async () => {
    const fetch = routedFetch([{ match: "/search/companies", body: search }, { match: "/company/12345678", body: profile }]);
    const candidates = await searchCandidates("focus green", ctx(fetch, env));
    expect(candidates.map((c) => [c.companyNumber, c.status])).toEqual([["12345678", "active"], ["00000009", "dissolved"]]);

    const { db, repo } = cps();
    const c = repo.create({ name: "Focus Green", roles: ["supplier"], ask: "annual_ghg_report", status: "active" });
    const r = await resolveCounterparty(db, c.id, "12345678", ctx(fetch, env));
    expect(r.counterparty).toMatchObject({ companyNumber: "12345678", country: "GB", name: "Focus Green" });
    expect(r.counterparty.sector).toContain("74901 Environmental consulting activities");
    expect(r.applied.join("; ")).toMatch(/company number 12345678; sector from SIC codes/);
    expect(r.warnings.join(" ")).toMatch(/register name is "FOCUS GREEN LIMITED"/);

    const kept = repo.create({ name: "FOCUS GREEN LIMITED", roles: ["supplier"], ask: "annual_ghg_report", status: "active", sector: "My own sector", country: "IE" });
    const r2 = await resolveCounterparty(db, kept.id, "12345678", ctx(fetch, env));
    expect(r2.counterparty).toMatchObject({ sector: "My own sector", country: "IE" });
    expect(r2.applied).toEqual(["company number 12345678"]);
    expect(r2.warnings.join(" ")).not.toMatch(/register name/);
  });

  it("warns when the register says the company is not active, and fails clearly without a key", async () => {
    const dissolved = { ...profile, company_status: "dissolved", date_of_cessation: "2024-03-01" };
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(dissolved), { status: 200 }));
    const { db, repo } = cps();
    const c = repo.create({ name: "Gone Ltd", roles: ["supplier"], ask: "annual_ghg_report", status: "active" });
    const r = await resolveCounterparty(db, c.id, "12345678", ctx(fetch, env));
    expect(r.warnings.join(" ")).toMatch(/records the company as dissolved \(ceased 2024-03-01\)/);
    await expect(searchCandidates("x", ctx(fetch, {}))).rejects.toBeInstanceOf(NotConfiguredError);
  });
});

describe("bulk waves", () => {
  it("records a request wave for every counterparty not yet asked, skipping the rest with a reason", () => {
    const { db, repo } = cps();
    const a = repo.create({ name: "A", roles: ["supplier"], ask: "annual_ghg_report", status: "active" });
    const b = repo.create({ name: "B", roles: ["tenant"], ask: "activity_ledger", status: "active" });
    const c = repo.create({ name: "C", roles: ["supplier"], ask: "annual_ghg_report", status: "active" });
    repo.create({ name: "Old", roles: ["supplier"], ask: "annual_ghg_report", status: "inactive" });
    const eng = new EngagementRepository(db);
    const e = eng.ensure(c.id, 2025, "annual_ghg_report");
    eng.applyTransition(e, transition(e, { reportingYear: 2025, action: "request_sent", on: "2026-01-05" }, "2026-01-05"), { action: "request_sent", at: "2026-01-05" });

    const input = bulkEngagementActionSchema.parse({ reportingYear: 2025, inStates: ["identified"], action: "request_sent", on: "2026-02-01", dueOn: "2026-03-31", channel: "email", detail: "Wave 1" });
    const r = applyBulkAction(db, input, new Date("2026-02-01T09:00:00Z"));
    expect(r.applied.map((x) => x.name).sort()).toEqual(["A", "B"]);
    expect(r.applied.every((x) => x.engagement.state === "contacted" && x.engagement.dueOn === "2026-03-31")).toBe(true);
    expect(r.applied.find((x) => x.name === "B")?.engagement.ask).toBe("activity_ledger"); // each keeps its own ask
    expect(r.skipped).toEqual([{ counterpartyId: c.id, name: "C", reason: "is request sent, no reply, not in the states selected" }]);
    expect(eng.events(eng.find(a.id, 2025)!.id)).toHaveLength(1);
    expect(eng.find(b.id, 2025)?.state).toBe("contacted");

    // A reminder wave by explicit id: C qualifies, A was only just contacted but the ladder is the caller's call; a verified one is refused by the state machine.
    const r2 = applyBulkAction(db, bulkEngagementActionSchema.parse({ reportingYear: 2025, counterpartyIds: [c.id, "missing"], action: "reminder_sent", on: "2026-02-20" }), new Date("2026-02-20T09:00:00Z"));
    expect(r2.applied.map((x) => [x.name, x.engagement.remindersSent])).toEqual([["C", 1]]);
    expect(r2.skipped).toEqual([{ counterpartyId: "missing", name: "missing", reason: "not found" }]);
  });

  it("refuses a wave with neither ids nor states, and a decline without a reason", () => {
    expect(bulkEngagementActionSchema.safeParse({ reportingYear: 2025, action: "request_sent" }).success).toBe(false);
    expect(bulkEngagementActionSchema.safeParse({ reportingYear: 2025, inStates: ["contacted"], action: "declined" }).success).toBe(false);
  });
});
