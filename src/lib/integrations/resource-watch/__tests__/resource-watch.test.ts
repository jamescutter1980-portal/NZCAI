// Fixture mirrors the RW API JSON:API dataset envelope (data[].attributes, meta) as seen in resource-watch/resource-watch fixtures; not from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import type { FetchLike } from "../../framework";
import { runOperation, testContext } from "../../testing";

const envelope = {
  data: [
    {
      id: "0b9f0100-ce5b-430f-ad8f-3363efa05481",
      type: "dataset",
      attributes: {
        name: "Aqueduct Water Risk Atlas: Baseline Water Stress",
        slug: "wat-baseline-water-stress",
        provider: "cartodb",
        connectorType: "rest",
        published: true,
        env: "production",
        application: ["rw", "aqueduct"],
        updatedAt: "2026-02-01T10:00:00.000Z",
        metadata: [{ attributes: { language: "en", description: "Ratio of total water withdrawals to available renewable supply.", source: "WRI Aqueduct", license: "CC BY 4.0" } }],
      },
    },
  ],
  links: { self: "https://api.resourcewatch.org/v1/dataset?search=water&page[size]=50" },
  meta: { "total-pages": 1, "total-items": 1, size: 50 },
};

describe("resource-watch", () => {
  it("searches with the documented query and maps JSON:API attributes", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(envelope), { status: 200 }));
    const result = await runOperation(definition, "search", { search: "water stress", application: "aqueduct" }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://api.resourcewatch.org/v1/dataset");
    expect(url.searchParams.get("search")).toBe("water stress");
    expect(url.searchParams.get("application")).toBe("aqueduct");
    expect(url.searchParams.get("page[size]")).toBe("50");
    expect(result.rows?.[0]).toMatchObject({ slug: "wat-baseline-water-stress", provider: "cartodb", licence: "CC BY 4.0", source: "WRI Aqueduct", applications: "rw, aqueduct" });
    expect(result.summary).toContain("1 datasets match");
    expect(result.provenance).toMatchObject({ source: "resource-watch", basis: "measured" });
  });

  it("returns an empty unavailable result and validates before the network", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ data: [], meta: { "total-items": 0 } }), { status: 200 }));
    const result = await runOperation(definition, "search", { search: "zzz" }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    const noNet = vi.fn();
    await expect(runOperation(definition, "search", {}, testContext(noNet))).rejects.toThrow();
    expect(noNet).not.toHaveBeenCalled();
  });
});
