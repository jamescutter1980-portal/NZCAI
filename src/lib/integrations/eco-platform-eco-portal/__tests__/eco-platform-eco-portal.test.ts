import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import search from "./fixtures/search.json";
import process from "./fixtures/process.json";
const jsonFetch = (body: unknown, status = 200) => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

// Fixtures mirror the soda4LCA JSON shapes read by open-source ECO Portal clients;
// they are not live captures and every value is synthetic (1.111 etc.).
const env = { ECO_PORTAL_TOKEN: "eco-token" };

describe("eco-platform-eco-portal", () => {
  it("searches with the token as a Bearer header and maps list entries", async () => {
    const fetch = jsonFetch(search, 200);
    const res = await runOperation(definition, "search", { name: "concrete", valid_until: 2026 }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://data.eco-platform.org/resource/processes");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ search: "true", name: "concrete", format: "json", pageSize: "25", startIndex: "0", validUntil: "2026", distributed: "true", virtual: "true", lang: "en" });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer eco-token");
    expect(res.rows).toHaveLength(2);
    expect(res.rows?.[0]).toMatchObject({ uuid: "00000000-0000-4000-8000-000000000001", name: "Synthetic test product", geography: "DE", valid_until: 2029, reference_year: 2024, node: "SYNNODE", registration_no: "SYN-0001" });
    expect(res.rows?.[1]).toMatchObject({ name: "Second product", valid_until: 2027, classification: "Insulation" });
    expect(res.summary).toContain("2 EPD(s)");
    expect(res.provenance).toMatchObject({ source: "eco-platform-eco-portal", basis: "measured" });
  });

  it("reads a dataset and returns GWP by module with declared unit, never mixing A1-A3 with A4/A5", async () => {
    const fetch = jsonFetch(process, 200);
    const res = await runOperation(definition, "detail", { uuid: "00000000-0000-4000-8000-000000000001", version: "00.01.000" }, testContext(fetch, env));
    const u = new URL(fetch.mock.calls[0][0]);
    expect(u.pathname).toBe("/resource/processes/00000000-0000-4000-8000-000000000001");
    expect(Object.fromEntries(u.searchParams)).toEqual({ format: "json", view: "extended", lang: "en", version: "00.01.000" });
    expect(res.summary).toContain("GWP-total A1-A3 = 1.111 kg CO2 eq. per 1 m3");
    const total = res.rows?.filter((r) => r.indicator === "GWP-total");
    expect(total?.map((r) => [r.module, r.value_kgco2e])).toEqual([["A1-A3", 1.111], ["A4", 0.222], ["A5", null], ["C1", 0], ["C2", 0.033], ["C3", 0.044], ["C4", null], ["D", -0.555]]);
    expect(res.rows?.some((r) => r.indicator === "GWP-fossil")).toBe(true);
    expect(res.warnings?.some((w) => w.includes("Never mix A1-A3"))).toBe(true);
    expect(res.provenance).toMatchObject({ basis: "measured", version: "00000000-0000-4000-8000-000000000001 v00.01.000" });
  });

  it("uses a member-node uri without sending the ECO Portal token", async () => {
    const fetch = jsonFetch(process, 200);
    const res = await runOperation(definition, "detail", { uuid: "00000000-0000-4000-8000-000000000001", uri: "https://synthetic-node.example/resource/processes/00000000-0000-4000-8000-000000000001?version=00.01.000" }, testContext(fetch, env));
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://synthetic-node.example/resource/processes/00000000-0000-4000-8000-000000000001?version=00.01.000&format=json&view=extended&lang=en");
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(res.warnings?.[0]).toContain("without the ECO Portal token");
    await expect(runOperation(definition, "detail", { uuid: "00000000-0000-4000-8000-000000000001", uri: "http://insecure.example/x" }, testContext(fetch, env))).rejects.toThrow(/https/);
  });

  it("reports 404 as unavailable and validates before fetching", async () => {
    const fetch = vi.fn(routedFetch([{ match: "/processes/", status: 404, body: "not found" }]));
    const res = await runOperation(definition, "detail", { uuid: "00000000-0000-4000-8000-00000000dead" }, testContext(fetch, env));
    expect(res.rows).toEqual([]);
    expect(res.provenance.basis).toBe("unavailable");
    const noCall = vi.fn();
    await expect(runOperation(definition, "detail", { uuid: "not-a-uuid" }, testContext(noCall, env))).rejects.toThrow(/UUID/);
    await expect(runOperation(definition, "search", { name: "x" }, testContext(noCall, {}))).rejects.toThrow(/ECO_PORTAL_TOKEN/);
    expect(noCall).not.toHaveBeenCalled();
  });
});
