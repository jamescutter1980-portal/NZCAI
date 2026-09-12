import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

describe("mosl-water-market", () => {
  it("is a consent-based reference-only source", async () => {
    expect(definition).toMatchObject({ status: "reference_only", access: "authorised", licence: "consent_based" });
    const fetch = vi.fn();
    const result = await runOperation(definition, "links", {}, testContext(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.links?.length).toBe(4);
  });
});
