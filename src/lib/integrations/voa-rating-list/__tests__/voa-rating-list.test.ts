import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

describe("voa-rating-list", () => {
  it("is reference-only and returns links without touching the network", async () => {
    const fetch = vi.fn();
    expect(definition.status).toBe("reference_only");
    expect(definition.envVars).toEqual([]);
    const result = await runOperation(definition, "links", {}, testContext(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.rows?.length).toBeGreaterThan(0);
    expect(result.links?.length).toBe(result.rows?.length);
    for (const l of result.links ?? []) expect(l.url).toMatch(/^https:\/\//);
    expect(result.provenance).toMatchObject({ source: "voa-rating-list", basis: "not_applicable", territory: definition.territory });
    expect(result.summary.length).toBeGreaterThan(20);
  });
});
