import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

describe("jba-flood", () => {
  it("is a commercial reference-only source", async () => {
    expect(definition).toMatchObject({ status: "reference_only", access: "commercial", group: "flood_water" });
    const fetch = vi.fn();
    const result = await runOperation(definition, "links", {}, testContext(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.links?.[0].url).toContain("jbarisk.com");
  });
});
