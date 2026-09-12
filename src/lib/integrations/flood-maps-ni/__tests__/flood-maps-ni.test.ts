import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

describe("flood-maps-ni", () => {
  it("is a reference-only definition whose links operation never touches the network", async () => {
    expect(definition.status).toBe("reference_only");
    expect(definition.territory).toBe("Northern Ireland");
    const fetch = vi.fn();
    const result = await runOperation(definition, "links", {}, testContext(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.links?.length).toBeGreaterThan(2);
    expect(result.provenance.basis).toBe("not_applicable");
  });
});
