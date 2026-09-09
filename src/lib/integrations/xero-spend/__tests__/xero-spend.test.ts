import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

describe("xero-spend", () => {
  it("is reference-only with guidance notes and a links operation that never fetches", async () => {
    expect(definition.id).toBe("xero-spend");
    expect(definition.status).toBe("reference_only");
    expect(definition.notes?.length).toBeGreaterThan(2);
    const fetch = vi.fn();
    const res = await runOperation(definition, "links", {}, testContext(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(res.links?.length).toBeGreaterThan(0);
    expect(res.rows?.length).toBe(res.links?.length);
    expect(res.provenance).toMatchObject({ source: "xero-spend", basis: "not_applicable" });
  });
});
