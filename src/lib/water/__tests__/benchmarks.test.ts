import { describe, expect, it } from "vitest";
import { estimateConsumption, WATER_BENCHMARKS } from "../benchmarks";

describe("water benchmarks", () => {
  it("estimates from floor area", () => {
    const e = estimateConsumption({ propertyType: "office", floorAreaM2: 1000, days: 365 });
    expect(e.method).toBe("area");
    expect(e.m3).toBe(WATER_BENCHMARKS.office.m3PerM2PerYear * 1000);
    expect(e.warnings[0]).toMatch(/Estimated only/);
  });

  it("prefers occupancy when provided", () => {
    const e = estimateConsumption({ propertyType: "residential", occupants: 2, days: 365 });
    expect(e.method).toBe("occupancy");
    expect(e.m3).toBe(Math.round(((2 * 140 * 365) / 1000) * 1000) / 1000);
  });

  it("returns unavailable without inputs", () => {
    const e = estimateConsumption({ propertyType: "warehouse" });
    expect(e.method).toBe("unavailable");
    expect(e.m3).toBe(0);
  });
});
