import { describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { routedFetch, runOperation, testContext } from "../../testing";
import datastocks from "./fixtures/datastocks.json";
import search from "./fixtures/search.json";
import process from "./fixtures/process.json";
const jsonFetch = (body: unknown, status = 200) => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

// Fixtures mirror the soda4LCA JSON shapes read by open-source ÖKOBAUDAT clients;
// they are not live captures and every value is synthetic.
describe("okobaudat", () => {
  it("lists data stocks without any key", async () => {
    const fetch = jsonFetch(datastocks, 200);
    const res = await runOperation(definition, "datastocks", {}, testContext(fetch));
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oekobaudat.de/OEKOBAU.DAT/resource/datastocks?format=json");
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(res.rows?.[0]).toMatchObject({ uuid: "aaaaaaaa-0000-4000-8000-000000000001", short_name: "OBD_TEST_I", name: "ÖKOBAUDAT TEST release I", description: "Synthetic stock", root: false });
    expect(definition.envVars).toEqual([]);
  });

  it("searches within a data stock and in the root stock", async () => {
    const fetch = jsonFetch(search, 200);
    const res = await runOperation(definition, "search", { name: "Beton", datastock: "aaaaaaaa-0000-4000-8000-000000000001" }, testContext(fetch));
    const u = new URL(fetch.mock.calls[0][0]);
    expect(u.pathname).toBe("/OEKOBAU.DAT/resource/datastocks/aaaaaaaa-0000-4000-8000-000000000001/processes");
    expect(Object.fromEntries(u.searchParams)).toEqual({ search: "true", format: "json", lang: "en", name: "Beton", pageSize: "25", startIndex: "0" });
    expect(res.rows?.[0]).toMatchObject({ uuid: "00000000-0000-4000-8000-000000000001", name: "Synthetisches Testprodukt", sub_type: "generic dataset", node: "OEKOBAU.DAT" });
    expect(res.provenance.version).toBe("datastock aaaaaaaa-0000-4000-8000-000000000001");
    await runOperation(definition, "search", { name: "Beton" }, testContext(fetch));
    expect(new URL(fetch.mock.calls[1][0]).pathname).toBe("/OEKOBAU.DAT/resource/processes");
    await expect(runOperation(definition, "search", { name: "Beton", datastock: "nope" }, testContext(fetch))).rejects.toThrow(/UUID/);
  });

  it("extracts GWP by module from the shared ILCD code", async () => {
    const fetch = jsonFetch(process, 200);
    const res = await runOperation(definition, "detail", { uuid: "00000000-0000-4000-8000-000000000001" }, testContext(fetch));
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("view")).toBe("extended");
    expect(res.rows?.find((r) => r.indicator === "GWP-total" && r.module === "A1-A3")).toMatchObject({ value_kgco2e: 1.111, declared_unit: "1 m3", unit: "kg CO2 eq." });
    expect(res.rows?.find((r) => r.indicator === "GWP-total" && r.module === "A5")).toMatchObject({ value_kgco2e: null, availability: "not_declared", raw: "ND" });
    expect(res.provenance).toMatchObject({ source: "okobaudat", basis: "measured" });
  });

  it("returns unavailable on 404 and validates before fetching", async () => {
    const fetch = vi.fn(routedFetch([{ match: "/processes/", status: 404, body: "" }]));
    const res = await runOperation(definition, "detail", { uuid: "00000000-0000-4000-8000-00000000dead" }, testContext(fetch));
    expect(res.provenance.basis).toBe("unavailable");
    const noCall = vi.fn();
    await expect(runOperation(definition, "detail", { uuid: "x" }, testContext(noCall))).rejects.toThrow();
    await expect(runOperation(definition, "search", { name: "x", page_size: 0 }, testContext(noCall))).rejects.toThrow();
    expect(noCall).not.toHaveBeenCalled();
  });
});
