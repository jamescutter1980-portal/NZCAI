import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

describe("ukradon", () => {
  it("is a reference-only source with open atlas links", async () => {
    expect(definition.status).toBe("reference_only");
    const fetch = vi.fn();
    const result = await runOperation(definition, "links", {}, testContext(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.links?.some((l) => /Indicative Atlas/.test(l.label))).toBe(true);
  });
});
