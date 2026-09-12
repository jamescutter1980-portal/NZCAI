import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import type { FetchLike } from "../../framework";
import { runOperation, testContext } from "../../testing";
import lookup from "./fixtures/lookup.json";

describe("postcodes-io", () => {
  it("looks up a postcode and normalises the input", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(lookup), { status: 200 }));
    const result = await runOperation(definition, "lookup", { postcode: "sw1a 1aa" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://api.postcodes.io/postcodes/SW1A1AA");
    expect(result.rows?.[0]).toMatchObject({ postcode: "SW1A 1AA", latitude: 51.501009, lsoa_code: "E01004736" });
    expect(result.summary).toContain("Westminster");
    expect(result.provenance).toMatchObject({ source: "postcodes-io", basis: "measured", licence: "OGL" });
  });

  it("reports a missing postcode without throwing", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: 404, error: "Postcode not found" }), { status: 404 }));
    const result = await runOperation(definition, "lookup", { postcode: "ZZ1 1ZZ" }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("rejects an invalid postcode before calling the API", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "lookup", { postcode: "nope" }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
