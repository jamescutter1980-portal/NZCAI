import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

describe("defra-noise-mapping", () => {
  it("is reference-only with download links and no network calls", async () => {
    expect(definition.status).toBe("reference_only");
    const fetch = vi.fn();
    const result = await runOperation(definition, "links", {}, testContext(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.links?.some((l) => /Round 4/.test(l.label))).toBe(true);
    expect(definition.notes?.join(" ")).toMatch(/BREEAM/);
  });
});
