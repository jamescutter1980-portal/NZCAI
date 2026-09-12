import { describe, expect, it } from "vitest";
import { a1a3Total, classifyIndicator, extractDeclaredUnit, extractIndicators, gwpModuleRows, normaliseModule, parseModuleValue, primaryGwp, summariseProcess } from "../ilcd";
import fixture from "./fixtures/ilcd-process.json";

// Fixture values are synthetic (1.111, 0.222 ...). The JSON shape follows the
// soda4LCA ILCD JSON as parsed by open-source clients, not a live capture.
describe("ilcd extraction", () => {
  it("summarises identity, declared unit and validity", () => {
    const s = summariseProcess(fixture);
    expect(s.uuid).toBe("00000000-0000-4000-8000-000000000001");
    expect(s.name).toBe("Synthetic test product"); // English preferred over German
    expect(s.version).toBe("00.01.000");
    expect(s.subType).toBe("generic dataset");
    expect(s.classification).toEqual(["Mineral building products", "Concrete"]);
    expect(s.referenceYear).toBe(2024);
    expect(s.validUntil).toBe(2029);
    expect(s.geography).toBe("DE");
    expect(s.declaredUnit).toMatchObject({ amount: 1, unit: "m3", flowName: "Synthetic test product" });
  });

  it("extracts GWP-total by module, keeping ND and MNA as null (not 0) and zero as 0", () => {
    const ind = extractIndicators(fixture);
    expect(ind).toHaveLength(3);
    const gwp = primaryGwp(ind)!;
    expect(gwp.kind).toBe("GWP-total");
    expect(gwp.unit).toBe("kg CO2 eq.");
    const byModule = Object.fromEntries(gwp.modules.map((m) => [m.module, m.value]));
    expect(byModule["A1-A3"]).toBe(1.111);
    expect(byModule.A4).toBe(0.222);
    expect(byModule.A5).toBeNull();
    expect(byModule.C1).toBe(0);
    expect(byModule.C4).toBeNull();
    expect(byModule.D).toBe(-0.555);
    expect(gwp.modules.find((m) => m.module === "A5")?.raw).toBe("ND");
    expect(gwp.modules.map((m) => m.module)).toEqual(["A1-A3", "A4", "A5", "C1", "C2", "C3", "C4", "D"]);
  });

  it("classifies indicators and does not treat GWP-fossil as the headline", () => {
    const ind = extractIndicators(fixture);
    expect(ind.map((i) => i.kind)).toEqual(["GWP-total", "GWP-fossil", "other"]);
    expect(classifyIndicator("Global warming potential (GWP)")).toBe("GWP-unspecified");
    expect(classifyIndicator("Climate change")).toBe("GWP-unspecified");
    expect(classifyIndicator("Global warming potential except emissions and uptake of biogenic carbon")).toBe("other");
    expect(classifyIndicator("anything", "93a60a56-a3c8-11da-a746-0800200b9a66")).toBe("GWP-unspecified");
  });

  it("produces flat rows with declared unit and availability", () => {
    const rows = gwpModuleRows(summariseProcess(fixture), ["GWP-total"]);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({ indicator: "GWP-total", module: "A1-A3", value_kgco2e: 1.111, availability: "declared", unit: "kg CO2 eq.", declared_unit: "1 m3" });
    expect(rows.find((r) => r.module === "C4")).toMatchObject({ value_kgco2e: null, availability: "not_declared", raw: "MNA" });
  });

  it("sums A1-A3 from parts only when the aggregate is missing and all parts are declared", () => {
    expect(a1a3Total(primaryGwp(extractIndicators(fixture)))).toBe(1.111);
    const parts = { name: "GWP-total", kind: "GWP-total" as const, modules: [
      { module: "A1", value: 1, raw: "1" }, { module: "A2", value: 2, raw: "2" }, { module: "A3", value: 3, raw: "3" },
    ] };
    expect(a1a3Total(parts)).toBe(6);
    const partial = { ...parts, modules: parts.modules.slice(0, 2) };
    expect(a1a3Total(partial)).toBeNull();
  });

  it("normalises module spellings and module values", () => {
    expect(normaliseModule("A1-3")).toBe("A1-A3");
    expect(normaliseModule("a1a2a3")).toBe("A1-A3");
    expect(normaliseModule(" C2 ")).toBe("C2");
    expect(parseModuleValue("MND")).toBeNull();
    expect(parseModuleValue("0")).toBe(0);
    expect(parseModuleValue(3.5)).toBe(3.5);
  });

  it("falls back to the reference flow by internal id and handles missing exchanges", () => {
    const noRef = { ...fixture, exchanges: { exchange: [{ ...fixture.exchanges.exchange[0], referenceFlow: undefined }] } };
    expect(extractDeclaredUnit(noRef)).toMatchObject({ amount: 1, unit: "m3" });
    expect(extractDeclaredUnit({})).toEqual({ amount: null });
  });
});
