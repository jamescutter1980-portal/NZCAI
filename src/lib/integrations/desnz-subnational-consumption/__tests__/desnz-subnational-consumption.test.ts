import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { definition, envUrls, fileName, indexHeader, outcodeOf, resolveUrl } from "..";
import type { FetchLike } from "../../framework";
import { runOperation, testContext } from "../../testing";

// Fixture files under fixtures/reference/desnz-subnational-consumption/ are
// SYNTHETIC: every meter count and kWh figure is invented. The column layout
// (Outcode, Postcode, Num_meters, Total_cons_kwh, Mean_cons_kwh,
// Median_cons_kwh with "All postcodes" outcode rows) follows DESNZ's notes and
// open-source users of the files; nothing was downloaded from gov.uk here.
const REF = fileURLToPath(new URL("./fixtures/reference", import.meta.url));
const ctx = () => testContext(vi.fn(), { REFERENCE_DATA_DIR: REF });

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "desnz-sub-"));
  mkdirSync(path.join(tmp, "desnz-subnational-consumption"), { recursive: true });
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("desnz-subnational-consumption", () => {
  it("detects the header and rejects a file without the consumption columns", () => {
    const file = { name: "gas-2024.csv", path: "/dev/null", modifiedAt: "x", sizeBytes: 1 };
    const idx = indexHeader([["Outcode", "Postcode", "Num_meters", "Total_cons_kwh", "Mean_cons_kwh", "Median_cons_kwh"]], file);
    expect(idx).toMatchObject({ fuel: "gas", year: 2024, meterType: "all", headerRowIndex: 0, columns: { postcode: 1, median: 5 } });
    expect(() => indexHeader([["a", "b"]], file)).toThrow(/no header row/);
    expect(() => indexHeader([["Postcode", "Num_meters"]], file)).toThrow(/missing columns/);
    expect(outcodeOf("SW1A1AA")).toBe("SW1A");
    expect(fileName("electricity", 2024, "economy7")).toBe("electricity-economy7-2024.csv");
  });

  it("returns postcode rows for every loaded year and fuel plus outcode aggregates, newest year first", async () => {
    const res = await runOperation(definition, "postcode", { postcode: "zz1 1aa" }, ctx());
    expect(res.rows?.map((r) => [r.year, r.fuel, r.level])).toEqual([
      [2024, "electricity", "postcode"],
      [2024, "electricity", "outcode"],
      [2024, "gas", "outcode"],
      [2023, "electricity", "postcode"],
      [2023, "electricity", "outcode"],
    ]);
    expect(res.rows?.[0]).toMatchObject({ postcode: "ZZ1 1AA", outcode: "ZZ1", meters: 12, total_kwh: 36000, mean_kwh: 3000, median_kwh: 2750.5, file: "electricity-2024.csv" });
    expect(res.rows?.[1]).toMatchObject({ level: "outcode", postcode: "", meters: 1234, median_kwh: 2999.5 });
    expect(res.summary).toContain("2 postcode row(s)");
    expect(res.summary).toContain("2024 electricity: 12 meters, median 2750.5 kWh");
    expect(res.provenance).toMatchObject({ source: "desnz-subnational-consumption", basis: "measured", licence: "OGL" });
    expect(res.provenance.version).toMatch(/file electricity-2024\.csv; modified/);
    expect(res.warnings?.some((w) => /area aggregates/.test(w))).toBe(true);
    expect(res.warnings?.some((w) => /suppresses/.test(w) && /gas-2024\.csv/.test(w))).toBe(true);
  });

  it("filters by fuel, can drop outcode rows, and keeps blank cells as null", async () => {
    const gas = await runOperation(definition, "postcode", { postcode: "ZZ1 1AB", fuel: "gas", include_outcode: false }, ctx());
    expect(gas.rows).toHaveLength(1);
    expect(gas.rows?.[0]).toMatchObject({ fuel: "gas", meters: 7, median_kwh: 11500 });
    const blank = await runOperation(definition, "postcode", { postcode: "ZZ2 9ZZ", fuel: "electricity", include_outcode: false }, ctx());
    expect(blank.rows?.[0]).toMatchObject({ meters: 6, total_kwh: null, mean_kwh: null, median_kwh: null });
  });

  it("reports a suppressed postcode via its outcode row, and an unknown outcode as unavailable", async () => {
    const res = await runOperation(definition, "postcode", { postcode: "ZZ2 1XX", fuel: "electricity" }, ctx());
    expect(res.rows?.map((r) => r.level)).toEqual(["outcode"]);
    expect(res.summary).toContain("not published (suppressed)");
    expect(res.provenance.basis).toBe("measured");
    const none = await runOperation(definition, "postcode", { postcode: "AB1 1AA" }, ctx());
    expect(none.rows).toEqual([]);
    expect(none.provenance.basis).toBe("unavailable");
    const empty = await runOperation(definition, "postcode", { postcode: "ZZ1 1AA" }, testContext(vi.fn(), { REFERENCE_DATA_DIR: REF + "/nowhere" }));
    expect(empty.rows).toEqual([]);
    expect(empty.summary).toContain("electricity-<year>.csv");
  });

  it("lists loaded files and publication links without the network", async () => {
    const fetch = vi.fn();
    const files = await runOperation(definition, "files", {}, testContext(fetch, { REFERENCE_DATA_DIR: REF }));
    expect(files.rows?.map((r) => r.file)).toEqual(["electricity-2024.csv", "gas-2024.csv", "electricity-2023.csv"]);
    expect(files.rows?.[0]).toMatchObject({ fuel: "electricity", year: 2024, meter_type: "all" });
    const links = await runOperation(definition, "links", {}, testContext(fetch, { REFERENCE_DATA_DIR: REF }));
    expect(links.rows?.some((r) => r.kind === "csv" && r.confidence === "confirmed")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves download URLs from the parameter, env override, then the built-in table", () => {
    expect(envUrls({ DESNZ_SUBNATIONAL_URLS: "electricity-2025=https://x/a.csv; gas-2025=https://x/b.csv?v=1" }).get("gas-2025")).toBe("https://x/b.csv?v=1");
    expect(resolveUrl({}, "gas", 2024)?.url).toContain("Postcode_level_gas_2024.csv");
    expect(resolveUrl({ DESNZ_SUBNATIONAL_URLS: "gas-2024=https://x/override.csv" }, "gas", 2024)).toEqual({ url: "https://x/override.csv", origin: "DESNZ_SUBNATIONAL_URLS" });
    expect(resolveUrl({}, "gas", 2024, "https://x/param.csv")?.origin).toBe("parameter");
    expect(resolveUrl({}, "gas", 2031)).toBeUndefined();
  });

  it("downloads a year to the reference directory and then reads it offline", async () => {
    const body = readFileSync(path.join(REF, "desnz-subnational-consumption", "gas-2024.csv"), "utf8");
    const fetch = vi.fn<FetchLike>(async () => new Response(body, { status: 200 }));
    const env = { REFERENCE_DATA_DIR: tmp };
    const res = await runOperation(definition, "download", { fuel: "gas", year: 2024 }, testContext(fetch, env));
    expect(fetch.mock.calls[0][0]).toBe("https://assets.publishing.service.gov.uk/media/6942a4e2501cdd438f4cf502/Postcode_level_gas_2024.csv");
    expect(res.rows?.[0]).toMatchObject({ fuel: "gas", year: 2024, url_origin: "built-in (confirmed)" });
    const noNet = vi.fn();
    const lookup = await runOperation(definition, "postcode", { postcode: "ZZ1 1AB" }, testContext(noNet, env));
    expect(noNet).not.toHaveBeenCalled();
    expect(lookup.rows?.[0]).toMatchObject({ fuel: "gas", year: 2024, meters: 7 });
    const bad = vi.fn<FetchLike>(async () => new Response("<html>not csv</html>", { status: 200 }));
    await expect(runOperation(definition, "download", { fuel: "gas", year: 2024 }, testContext(bad, env))).rejects.toThrow(/does not look like/);
    await expect(runOperation(definition, "download", { fuel: "gas", year: 2031 }, testContext(vi.fn(), env))).rejects.toThrow(/No download URL known/);
  });

  it("validates params before touching the filesystem or network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "postcode", { postcode: "nope" }, testContext(fetch, { REFERENCE_DATA_DIR: REF }))).rejects.toThrow();
    await expect(runOperation(definition, "postcode", { postcode: "ZZ1 1AA", fuel: "oil" }, testContext(fetch, { REFERENCE_DATA_DIR: REF }))).rejects.toThrow();
    await expect(runOperation(definition, "download", { fuel: "gas", year: 1999 }, testContext(fetch, { REFERENCE_DATA_DIR: REF }))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(definition.status).toBe("built_unverified");
  });
});
