import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetsRepository } from "@/lib/assets/repo";
import { calendarYear } from "@/lib/carbon/period";
import { ReadingsRepository } from "@/lib/db/readings-repo";
import { openDatabase } from "@/lib/db/sqlite";
import type { ConsentRecord } from "@/lib/consent/types";
import { testContext, routedFetch } from "@/lib/integrations/testing";
import type { MeterReading } from "@/lib/integrations/n3rgy";
import { assessReadiness, setEmissionsLoader, type ReadinessCheck, type ReadinessReport, summarise } from "..";

/**
 * Factor values in this file are SYNTHETIC (0.1 / 0.01 / 0.2 and a 300 gCO2/kWh
 * residual mix). They are not DESNZ or AIB published values and exist only to
 * exercise the plumbing; nothing here should be quoted as a factor.
 */
const DESNZ_CSV = `ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,GHG Conversion Factor 2025
1,Scope 2,UK electricity,Electricity generated,,,,kWh,kg CO2e,0.100
3,Scope 3,Transmission and distribution,T&D- UK electricity,,,,kWh,kg CO2e,0.010
4,Scope 1,Fuels,Gaseous fuels,Natural gas,,,kWh (Gross CV),kg CO2e,0.200
`;
const AIB_CSV = `data_year,country_code,country,residual_mix_gco2_per_kwh,direct_co2_only,publication,publication_date,source_url
2025,GB,United Kingdom,300.0,false,SYNTHETIC TEST VALUE,2026-05-26,https://example.test
`;

let dir: string;
let empty: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "readiness-"));
  empty = mkdtempSync(join(tmpdir(), "readiness-empty-"));
  mkdirSync(join(dir, "desnz-conversion-factors"), { recursive: true });
  mkdirSync(join(dir, "aib-residual-mix"), { recursive: true });
  writeFileSync(join(dir, "desnz-conversion-factors", "2025.csv"), DESNZ_CSV);
  writeFileSync(join(dir, "aib-residual-mix", "residual-mix.csv"), AIB_CSV);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
  setEmissionsLoader(undefined);
});

const NOW = new Date("2026-06-01T00:00:00Z");
const ctx = (referenceDir = dir) => testContext(routedFetch([]), { REFERENCE_DATA_DIR: referenceDir }, NOW);
const period = () => calendarYear(2025);

function reading(mpxn: string, utility: "electricity" | "gas", start: string, value: number): MeterReading {
  return {
    mpxn, utility, direction: "import", intervalStart: start, intervalEnd: start, value, unit: "kWh",
    provenance: { source: "n3rgy", dataset: "d", retrievedAt: "t", territory: "GB", licence: "consent_based", attribution: "a", basis: "measured" },
  };
}

function daily(mpxn: string, utility: "electricity" | "gas", fromIso: string, days: number, value: number): MeterReading[] {
  const start = Date.parse(fromIso);
  return Array.from({ length: days }, (_, i) => reading(mpxn, utility, new Date(start + i * 86_400_000).toISOString(), value));
}

function consent(mpxn: string, expiresOn: string, utilities: ("electricity" | "gas")[] = ["electricity"]): ConsentRecord {
  return {
    id: `consent-${mpxn}-${expiresOn}`, mpxn, utilities, occupierName: "Occupier Ltd", method: "letter_of_authority",
    grantedOn: "2024-12-01", expiresOn, status: "active", createdAt: "2024-12-01T00:00:00Z", updatedAt: "2024-12-01T00:00:00Z",
  };
}

/** A portfolio with nothing wrong in it: floor areas, coordinates, full-year readings, single allocation. */
function fullPortfolio() {
  const db = openDatabase(":memory:");
  const assets = new AssetsRepository(db);
  new ReadingsRepository(db).upsertReadings([
    ...daily("1000000000001", "electricity", "2025-01-01T00:00:00.000Z", 365, 10),
    ...daily("3000000000003", "gas", "2025-01-01T00:00:00.000Z", 365, 100),
  ]);
  const a = assets.create({ name: "Head office", postcode: "SW1A1AA", latitude: 51.5, longitude: -0.14, floorAreaM2: 2000 });
  assets.linkMeter(a.id, { mpxn: "1000000000001", utility: "electricity", direction: "import" });
  assets.linkMeter(a.id, { mpxn: "3000000000003", utility: "gas", direction: "import" });
  return { db, consents: [consent("1000000000001", "2027-12-31"), consent("3000000000003", "2027-12-31", ["gas"])] };
}

const find = (r: ReadinessReport, id: string): ReadinessCheck => {
  const c = r.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}; have ${r.checks.map((x) => x.id).join(", ")}`);
  return c;
};
const outstandingBlockers = (r: ReadinessReport) => r.checks.filter((c) => c.severity === "blocker" && c.status === "attention");

describe("assessReadiness", () => {
  it("makes a missing factor file a blocker and never reports it as ok", async () => {
    const { db, consents } = fullPortfolio();
    const r = await assessReadiness(db, ctx(empty), period(), { consents });
    const desnz = find(r, "reference.desnz_factors");
    expect(desnz.severity).toBe("blocker");
    expect(desnz.status).toBe("attention");
    expect(desnz.detail).toMatch(/DESNZ 2025/);
    expect(desnz.detail).toMatch(/data\/reference\/desnz-conversion-factors\/2025\.csv/);
    expect(r.score.blockers).toBeGreaterThan(0);
    // The residual mix is a gap, not a blocker: only the market-based total is affected.
    const aib = find(r, "reference.aib_residual_mix");
    expect(aib.severity).toBe("gap");
    expect(aib.status).toBe("attention");
  });

  it("makes an over-allocated shared meter a blocker and names the meter", async () => {
    const db = openDatabase(":memory:");
    const assets = new AssetsRepository(db);
    new ReadingsRepository(db).upsertReadings(daily("1000000000001", "electricity", "2025-01-01T00:00:00.000Z", 365, 10));
    const a = assets.create({ name: "A", floorAreaM2: 100 });
    const b = assets.create({ name: "B", floorAreaM2: 100 });
    assets.linkMeter(a.id, { mpxn: "1000000000001", utility: "electricity", direction: "import", share: 0.8 });
    assets.linkMeter(b.id, { mpxn: "1000000000001", utility: "electricity", direction: "import", share: 0.8 });

    const r = await assessReadiness(db, ctx(), period(), { consents: [consent("1000000000001", "2027-12-31")] });
    const alloc = find(r, "assets.allocation");
    expect(alloc.severity).toBe("blocker");
    expect(alloc.status).toBe("attention");
    expect(alloc.detail).toMatch(/1000000000001/);
    expect(alloc.detail).toMatch(/160%/);
    expect(alloc.detail).toMatch(/double counted/);
    expect(outstandingBlockers(r).map((c) => c.id)).toContain("assets.allocation");
  });

  it("treats readings held without an active consent as a blocker", async () => {
    const { db } = fullPortfolio();
    const r = await assessReadiness(db, ctx(), period(), { consents: [] });
    const held = find(r, "consents.readings_without_consent");
    expect(held.severity).toBe("blocker");
    expect(held.status).toBe("attention");
    expect(held.count).toBe(2);
    expect(held.detail).toMatch(/1000000000001/);
    expect(held.detail).toMatch(/without a live basis/);
  });

  it("finds no blockers in a fully populated portfolio with factors loaded", async () => {
    const { db, consents } = fullPortfolio();
    const r = await assessReadiness(db, ctx(), period(), { consents });

    expect(outstandingBlockers(r)).toHaveLength(0);
    expect(r.score.blockers).toBe(0);
    expect(find(r, "reference.desnz_factors").status).toBe("ok");
    expect(find(r, "assets.allocation").status).toBe("ok");
    expect(find(r, "consents.readings_without_consent").status).toBe("ok");
    expect(find(r, "assets.floor_area").status).toBe("ok");
    expect(find(r, "assets.completeness").status).toBe("ok");
    expect(find(r, "scope.s2_electricity").status).toBe("ok");
    expect(find(r, "scope.s1_stationary").status).toBe("ok");
    expect(r.summary).toMatch(/^No blockers for 2025: the return is ready to file subject to the exclusions the SECR export lists\./);

    // Scope coverage still reports what is absent, in the SECR export's own words.
    const travel = find(r, "scope.s3_c6_travel");
    expect(travel.severity).toBe("gap");
    expect(travel.status).toBe("attention");
    expect(travel.detail).toMatch(/No business travel has been recorded for this period\./);
    expect(find(r, "scope.s1_mobile").detail).toMatch(/SECR requires transport energy for UK operations/);

    // Nothing is ever reported with an empty detail, ok checks included.
    for (const c of r.checks) expect(c.detail.trim().length).toBeGreaterThan(20);
    expect(r.score.ok + r.score.attention + r.checks.filter((c) => c.status === "unknown").length).toBe(r.score.total);
  });

  it("names a consent expiring within 60 days of the period end", async () => {
    const { db } = fullPortfolio();
    const consents = [consent("1000000000001", "2026-02-14"), consent("3000000000003", "2027-12-31", ["gas"])];
    const r = await assessReadiness(db, ctx(), period(), { consents });
    const expiring = find(r, "consents.expiring");
    expect(expiring.severity).toBe("gap");
    expect(expiring.status).toBe("attention");
    expect(expiring.count).toBe(1);
    expect(expiring.detail).toMatch(/1000000000001 on 2026-02-14/);
    expect(expiring.detail).not.toMatch(/3000000000003/);

    // A consent that expires well after the window is not reported as expiring.
    const later = await assessReadiness(db, ctx(), period(), { consents: [consent("1000000000001", "2027-12-31"), consent("3000000000003", "2027-12-31", ["gas"])] });
    expect(find(later, "consents.expiring").status).toBe("ok");
    expect(find(later, "consents.expiring").detail).toMatch(/2027-12-31/);
  });

  it("reports unknown, not ok, when the emissions module cannot be loaded", async () => {
    const { db, consents } = fullPortfolio();
    setEmissionsLoader(() => Promise.reject(new Error("Cannot find module '@/lib/emissions'")));
    const r = await assessReadiness(db, ctx(), period(), { consents });

    for (const id of ["scope.s1_fugitive", "scope.s3_c5_waste"]) {
      const c = find(r, id);
      expect(c.status).toBe("unknown");
      expect(c.status).not.toBe("ok");
      expect(c.detail).toMatch(/emissions module/);
      expect(c.detail).toMatch(/Cannot find module/);
    }
    expect(find(r, "scope.s1_fugitive").detail).toMatch(/refrigerant/i);
    expect(r.summary).toMatch(/could not be run/);
  });

  it("reads coverage from the emissions module when it is present", async () => {
    const { db, consents } = fullPortfolio();
    setEmissionsLoader(async () => ({
      emissionsCarbon: () => ({ lines: [{ family: "refrigerant", kgCo2e: 1200 }, { family: "water", kgCo2e: 5 }] }),
    }));
    const r = await assessReadiness(db, ctx(), period(), { consents });
    expect(find(r, "scope.s1_fugitive").status).toBe("ok");
    expect(find(r, "scope.s1_fugitive").count).toBe(1);
    // Waste is a category the module knows about but holds nothing for: a gap, not unknown.
    expect(find(r, "scope.s3_c5_waste").status).toBe("attention");
    expect(find(r, "scope.s3_c5_waste").severity).toBe("gap");
  });

  it("leads the summary with the blockers, then the counts", async () => {
    const { db } = fullPortfolio();
    const r = await assessReadiness(db, ctx(empty), period(), { consents: [] });
    const blockers = outstandingBlockers(r);
    expect(blockers.length).toBeGreaterThanOrEqual(2);
    expect(r.summary).toMatch(/^\d+ blockers must be cleared before the 2025 return can be filed: /);
    expect(r.summary.indexOf(blockers[0].title)).toBeLessThan(r.summary.indexOf("gap"));
    expect(r.summary).toMatch(/DESNZ 2025 conversion factors/);
    expect(r.summary).toMatch(/Consent for stored readings/);
    expect(r.summary).toMatch(/must be disclosed as incomplete/);
  });

  it("reports every group and never leaves a check without a status", async () => {
    const { db, consents } = fullPortfolio();
    const r = await assessReadiness(db, ctx(), period(), { consents });
    expect([...new Set(r.checks.map((c) => c.group))].sort()).toEqual(["Assets", "Consents", "Integrations", "Reference data", "Scope coverage"]);
    expect(new Set(r.checks.map((c) => c.id)).size).toBe(r.checks.length);
    for (const c of r.checks) {
      expect(["ok", "attention", "unknown"]).toContain(c.status);
      expect(["blocker", "gap", "advisory"]).toContain(c.severity);
    }
    expect(r.period.label).toBe("2025");
  });
});

describe("summary honesty", () => {
  it("does not claim a return is ready to file while a blocker-severity check could not be run", () => {
    const period = calendarYear(2025);
    const unrun = summarise(
      [
        { id: "assets.allocation", group: "Assets", title: "Meter allocation", severity: "blocker", status: "unknown", detail: "No assets have been added, so there is nothing to check." },
        { id: "reference.desnz_factors", group: "Reference data", title: "DESNZ factors", severity: "blocker", status: "ok", detail: "Loaded." },
      ],
      period,
    );
    expect(unrun).toMatch(/cannot be confirmed/);
    expect(unrun).not.toMatch(/ready to file/);
    expect(unrun).toMatch(/Meter allocation/);

    const clean = summarise(
      [{ id: "assets.allocation", group: "Assets", title: "Meter allocation", severity: "blocker", status: "ok", detail: "Every shared meter adds up to 100%." }],
      period,
    );
    expect(clean).toMatch(/ready to file/);
  });
});
