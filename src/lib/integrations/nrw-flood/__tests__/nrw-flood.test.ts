// The NRW warning JSON field names are not published in reachable documentation;
// the fixture uses plausible PascalCase names to exercise the loose matching.
import type { FetchLike } from "../../framework";
import { describe, expect, it, vi } from "vitest";
import { definition, severityLevel } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import warnings from "./fixtures/warnings.json";

describe("nrw-flood", () => {
  it("sends the subscription key and builds the distance route", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(warnings), { status: 200 }));
    const result = await runOperation(definition, "warnings-near", { latitude: 51.55, longitude: -3.3, distance: 15000 }, testContext(fetch, { NRW_API_KEY: "abc123" }));
    expect(fetch.mock.calls[0][0]).toBe("https://api.naturalresources.wales/floodwarnings/v3/distance/15000/latlon/51.55/-3.3");
    expect((fetch.mock.calls[0][1] as RequestInit).headers).toMatchObject({ "Ocp-Apim-Subscription-Key": "abc123" });
    expect(result.rows?.[0]).toMatchObject({ severity_level: 2, severity: "Flood Warning", area: "River Taff at Pontypridd", area_code: "WAF001", river_or_sea: "River Taff" });
    expect(result.rows?.[0].distance_km).toBeGreaterThan(0);
    expect(result.summary).toContain("1 Flood Warning, 1 Flood Alert");
    expect(result.provenance).toMatchObject({ territory: "Wales", basis: "measured" });
  });

  it("refuses to run without a key and never calls the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "warnings-all", {}, testContext(fetch))).rejects.toThrow(/NRW_API_KEY/);
    await expect(runOperation(definition, "warnings-near", { latitude: 51, longitude: -3, distance: 10 }, testContext(fetch, { NRW_API_KEY: "k" }))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns unavailable on an empty feed and surfaces 401 as an error", async () => {
    const empty = await runOperation(definition, "warnings-all", {}, testContext(routedFetch([{ match: "/floodwarnings/v3/all", body: [] }]), { NRW_API_KEY: "k" }));
    expect(empty.rows).toEqual([]);
    expect(empty.provenance.basis).toBe("unavailable");
    await expect(runOperation(definition, "warnings-all", {}, testContext(routedFetch([{ match: "/all", status: 401, body: { message: "Access denied due to invalid subscription key." } }]), { NRW_API_KEY: "bad" }))).rejects.toThrow(/HTTP 401/);
    expect(severityLevel({ warningType: "Severe Flood Warning" })).toBe(1);
    expect(severityLevel({ status: "no longer in force" })).toBe(4);
    expect(severityLevel({})).toBeNull();
  });
});
