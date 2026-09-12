import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

describe("ukcp18", () => {
  it("is reference-only and returns links without touching the network", async () => {
    expect(definition.status).toBe("reference_only");
    expect(definition.notes?.length).toBeGreaterThan(2);
    const fetch = vi.fn();
    const result = await runOperation(definition, "links", {}, testContext(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.links?.length).toBeGreaterThan(0);
    expect(result.rows?.every((r) => typeof r.url === "string" && String(r.url).startsWith("https://"))).toBe(true);
    expect(result.provenance).toMatchObject({ source: "ukcp18", basis: "not_applicable" });
  });
});
