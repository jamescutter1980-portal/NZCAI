import { describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/sqlite";
import { AssetNotFoundError, AssetsRepository } from "../repo";
import { assetCreateSchema, formatPostcode } from "../types";

describe("AssetsRepository", () => {
  it("creates, updates, links meters and deletes with cascade", () => {
    const db = openDatabase(":memory:");
    const repo = new AssetsRepository(db);
    const a = repo.create(assetCreateSchema.parse({ name: "Unit 4", postcode: "sw1a 1aa", latitude: "51.5", longitude: "-0.14", floorAreaM2: "1200" }));
    expect(a.postcode).toBe("SW1A1AA");
    expect(a.floorAreaM2).toBe(1200);
    repo.linkMeter(a.id, { mpxn: "1234567890123", utility: "electricity", direction: "import", supplierFactorKgCo2ePerKwh: 0, supplierFactorEvidence: "REGO-backed contract 2026" });
    repo.linkMeter(a.id, { mpxn: "9876543210", utility: "gas", direction: "import" });
    repo.linkMeter(a.id, { mpxn: "1234567890123", utility: "electricity", direction: "import", label: "Main incomer" });
    const meters = repo.meters(a.id);
    expect(meters).toHaveLength(2);
    expect(meters.find((m) => m.utility === "electricity")?.label).toBe("Main incomer");
    expect(repo.assetsForMeter("9876543210")[0].id).toBe(a.id);
    const u = repo.update(a.id, { uprn: "100023336956", name: "Unit 4A" });
    expect(u.uprn).toBe("100023336956");
    expect(repo.get(a.id)?.name).toBe("Unit 4A");
    expect(repo.unlinkMeter(a.id, "9876543210", "gas", "import")).toBe(true);
    repo.delete(a.id);
    expect(repo.get(a.id)).toBeUndefined();
    expect(repo.meters(a.id)).toEqual([]);
    expect(() => repo.update(a.id, { name: "x" })).toThrow(AssetNotFoundError);
  });

  it("validates UPRN and postcode", () => {
    expect(() => assetCreateSchema.parse({ name: "x", uprn: "abc" })).toThrow();
    expect(() => assetCreateSchema.parse({ name: "x", postcode: "nope" })).toThrow();
    expect(formatPostcode("SW1A1AA")).toBe("SW1A 1AA");
  });
});
