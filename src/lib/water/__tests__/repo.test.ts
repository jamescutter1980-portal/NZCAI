import { describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/sqlite";
import { ConsumptionNotFoundError, SupplyPointNotFoundError, WaterRepository, consumptionCreateSchema, supplyPointCreateSchema, toM3 } from "..";
import { summarisePortfolio } from "../summary";

describe("WaterRepository", () => {
  it("registers supply points and stores consumption", () => {
    const db = openDatabase(":memory:");
    const repo = new WaterRepository(db);
    const sp = repo.createSupplyPoint(
      supplyPointCreateSchema.parse({
        spid: "3012345678",
        service: "water",
        postcode: "sw1a 1aa",
        retailerId: "wave",
        wholesalerId: "thames-water",
        propertyType: "office",
        floorAreaM2: "1200",
      }),
    );
    expect(sp.postcode).toBe("SW1A1AA");
    expect(repo.getSupplyPointBySpid("3012345678")?.id).toBe(sp.id);

    const reading = repo.createConsumption(
      consumptionCreateSchema.parse({
        supplyPointId: sp.id,
        periodStart: "2025-01-01",
        periodEnd: "2025-03-31",
        volumeM3: 45.5,
        basis: "client_declared",
        source: "bill",
        unitCostGbpPerM3: 2,
      }),
    );
    expect(reading.volumeM3).toBe(45.5);
    expect(repo.listConsumption({ supplyPointId: sp.id })).toHaveLength(1);

    const summary = summarisePortfolio(repo.listSupplyPoints(), repo.listConsumption());
    expect(summary.totalM3).toBe(45.5);
    expect(summary.costGbp).toBe(91);
    expect(summary.byBasis.client_declared).toBe(45.5);

    repo.updateConsumption(reading.id, { volumeM3: 50 });
    expect(repo.getConsumption(reading.id)?.volumeM3).toBe(50);
    repo.deleteConsumption(reading.id);
    expect(() => repo.deleteConsumption(reading.id)).toThrow(ConsumptionNotFoundError);

    repo.deleteSupplyPoint(sp.id);
    expect(() => repo.updateSupplyPoint(sp.id, { label: "x" })).toThrow(SupplyPointNotFoundError);
  });

  it("rejects consumption without a supply point", () => {
    const db = openDatabase(":memory:");
    const repo = new WaterRepository(db);
    expect(() =>
      repo.createConsumption(
        consumptionCreateSchema.parse({
          supplyPointId: "missing",
          periodStart: "2025-01-01",
          periodEnd: "2025-01-31",
          volumeM3: 1,
        }),
      ),
    ).toThrow(SupplyPointNotFoundError);
  });

  it("converts litres to m3", () => {
    expect(toM3(1500, "litres")).toBe(1.5);
    expect(toM3(2, "m3")).toBe(2);
    expect(toM3(1, "firkins")).toBeNull();
  });
});
