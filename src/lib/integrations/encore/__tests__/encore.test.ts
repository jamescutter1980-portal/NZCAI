import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

describe("encore", () => {
  it("is reference-only with notes and returns links without the network", async () => {
    expect(definition.status).toBe("reference_only");
    expect(definition.notes?.length).toBeGreaterThan(0);
    const fetch = vi.fn();
    const result = await runOperation(definition, "links", {}, testContext(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.links?.[0].url).toBe("https://encorenature.org/");
    expect(result.provenance).toMatchObject({ source: "encore", basis: "not_applicable" });
  });
});
