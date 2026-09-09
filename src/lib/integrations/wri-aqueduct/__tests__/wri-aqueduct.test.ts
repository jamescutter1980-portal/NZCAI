import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

describe("wri-aqueduct", () => {
  it("is a reference-only global source that points to the EA classification for England", async () => {
    expect(definition).toMatchObject({ status: "reference_only", territory: "Global" });
    const fetch = vi.fn();
    const result = await runOperation(definition, "links", {}, testContext(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.links?.some((l) => /water stressed areas/i.test(l.label))).toBe(true);
  });
});
