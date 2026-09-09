import { describe, expect, it } from "vitest";
import { definition } from "..";

describe("xoserve-gas-data", () => {
  it("is a reference-only definition with access guidance and no operations", () => {
    expect(definition.id).toBe("xoserve-gas-data");
    expect(definition.name).toContain("Xoserve");
    expect(definition.status).toBe("reference_only");
    expect(definition.operations).toEqual([]);
    expect(definition.notes?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(definition.notes?.some((n) => /access/i.test(n))).toBe(true);
    expect(definition.envVars).toEqual([]);
  });
});
