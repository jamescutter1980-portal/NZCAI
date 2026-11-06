import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyWorks } from "../classify";
import { demandStatistics } from "../aspects/demand";
import { networkCarbonFactor, networkEnergyUse, networkLimit } from "../aspects/district-networks";
import { gridFactor, occupancyRate } from "../aspects/operational-energy";
import { leakageKg } from "../aspects/refrigerants";
import { containsProhibitedClaim } from "../language";
import { findLimit, loadNzcbsReference, otherLimit, renewablesTarget, type LimitQuery } from "../reference";
import type { RefrigerantSystem, WorksFacts } from "../types";

/**
 * The shared vectors in tests/nzcbs/vectors.json: numbers read from the
 * Standard's own text (Annex A rows, the worked notes in section 5). The
 * Python MCP layer runs the same file, so the two implementations agree.
 */

const vectors = JSON.parse(readFileSync(path.resolve("tests/nzcbs/vectors.json"), "utf8"));
const ref = loadNzcbsReference({}, vectors.version)!;

describe("bundled reference tables", () => {
  it("load the Rev 1 version with checksums intact", () => {
    expect(ref).not.toBeNull();
    expect(ref.version).toBe("v1r1");
    expect(ref.bundled).toBe(true);
    expect(ref.limits.length).toBe(ref.manifest.files["limits.csv"].rows);
    expect(ref.sectors).toHaveLength(13);
    expect(ref.menus["Which works type are you reporting?"]).toEqual(["New Works", "Retrofit Works", "Reportable Works", "no works to be reported"]);
  });
});

describe("Annex A limit lookups", () => {
  for (const v of vectors.limits as (LimitQuery & { note: string; expect: { status: string; value: number | null; unit?: string; year?: number } })[]) {
    it(v.note, () => {
      const r = findLimit(ref, { table: v.table, sector: v.sector, subsector: v.subsector, scope: v.scope, areaBasis: v.areaBasis, year: v.year });
      expect(r.status).toBe(v.expect.status);
      expect(r.value).toBe(v.expect.value);
      if (v.expect.unit) expect(r.unit).toBe(v.expect.unit);
      if (v.expect.year) expect(r.year).toBe(v.expect.year);
    });
  }
});

describe("Annex A3 and A4", () => {
  for (const v of vectors.renewables_targets) {
    it(`${v.region} / ${v.group} = ${v.expect}`, () => {
      expect(renewablesTarget(ref, v.region, v.group)?.value).toBe(v.expect);
    });
  }
  it("other limits", () => {
    for (const [key, value] of Object.entries(vectors.other_limits as Record<string, number>)) expect(otherLimit(ref, key)?.value).toBe(value);
  });
});

describe("equations", () => {
  it("Equation 1a", () => {
    for (const v of vectors.equation_1a) {
      const value = v.parts.reduce((n: number, p: { share: number; limit: number }) => n + p.share * p.limit, 0);
      expect(Math.round(value * 1000) / 1000).toBe(v.expect);
    }
  });
  it("Equation 1b", () => {
    for (const v of vectors.equation_1b) {
      const value = v.newShare * v.ln + (1 - v.newShare) * v.le + v.newShare * (v.ln - v.le);
      expect(Math.round(value * 1000) / 1000).toBe(v.expect);
    }
  });
  it("Equation 5", () => {
    for (const v of vectors.equation_5) expect(v.target * Math.min(1, v.unconstrainedAreaM2 / v.footprintM2)).toBe(v.expect);
  });
  it("Equation 4", () => {
    for (const v of vectors.equation_4) expect(occupancyRate(v).rate).toBe(v.expect);
  });
  it("5.2.3.4 grid factor", () => {
    for (const v of vectors.grid_factor) expect(gridFactor(v)).toBe(v.expect);
  });
  it("Equations 6a, 6b, 7a, 7b against the Standard's notes", () => {
    for (const v of vectors.dhcn_limits) expect(Math.abs(networkLimit(v.service, v.existing, v.gridFactor).value - v.expect)).toBeLessThanOrEqual(v.tolerance);
  });
  it("Equations 2a and 2b", () => {
    for (const v of vectors.equation_2) {
      const n = { name: "n", service: "heating" as const, existing: true, suppliesFossilHeat: false, ...v };
      expect(networkEnergyUse(n)).toBe(v.expectEnergyUseKwh);
      expect(networkCarbonFactor(n)).toBe(v.expectFactor);
    }
  });
  it("Equations 8 and 9", () => {
    for (const v of vectors.refrigerants) {
      const systems = v.systems as RefrigerantSystem[];
      const charge = systems.reduce((n, s) => n + s.chargeKg * s.gwp, 0);
      expect(charge).toBe(v.expectChargeKgCo2e);
      for (const e of v.expectLeakage) {
        const l = leakageKg(systems.find((s) => s.id === e.id)!);
        expect(l.equation).toBe(e.equation);
        expect(l.kg).toBe(e.kg);
      }
      const kyoto = systems.reduce((n, s) => n + (leakageKg(s).kg ?? 0) * s.gwp, 0);
      expect(Math.round(kyoto * 10) / 10).toBe(v.expectKyotoLeakageKgCo2e);
      expect(systems.filter((s) => s.gwp > vectors.other_limits.refrigerant_gwp_limit).map((s) => s.id)).toEqual(v.expectGwpFails);
    }
  });
  it("5.6.3 demand statistics", () => {
    for (const v of vectors.demand) {
      const s = demandStatistics(v.intervalKwh, v.resolutionMinutes);
      expect(s.topTenKw).toEqual(v.expectTopTenKw);
      expect(s.p50Kw).toBe(v.expectP50Kw);
      expect(s.p1Kw).toBe(v.expectP1Kw);
    }
  });
  it("Table 5 works type", () => {
    for (const v of vectors.works_type as { facts: WorksFacts; expect: string }[]) expect(classifyWorks(v.facts).value).toBe(v.expect);
  });
  it("section 7 prohibited claims", () => {
    for (const t of vectors.prohibited_claims.prohibited) expect(containsProhibitedClaim(t), t).toBe(true);
    for (const t of vectors.prohibited_claims.permitted) expect(containsProhibitedClaim(t), t).toBe(false);
  });
});
