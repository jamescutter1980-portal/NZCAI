import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

describe("groundsure", () => {
  it("is a commercial reference-only source", async () => {
    expect(definition).toMatchObject({ status: "reference_only", access: "commercial", licence: "commercial" });
    const fetch = vi.fn();
    const result = await runOperation(definition, "links", {}, testContext(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.links?.length).toBeGreaterThan(0);
  });
});
