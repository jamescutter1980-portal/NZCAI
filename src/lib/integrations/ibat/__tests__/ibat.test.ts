import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

describe("ibat", () => {
  it("is a commercial reference-only source with notes and links", async () => {
    expect(definition.status).toBe("reference_only");
    expect(definition.access).toBe("commercial");
    expect(definition.notes?.length).toBeGreaterThan(0);
    const fetch = vi.fn();
    const result = await runOperation(definition, "links", {}, testContext(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.links?.length).toBeGreaterThan(0);
    expect(result.provenance).toMatchObject({ source: "ibat", basis: "not_applicable", licence: "commercial" });
  });
});
