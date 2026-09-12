import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_CSV_URL, definition, parseRepd } from "..";
import type { FetchLike } from "../../framework";
import { runOperation, testContext } from "../../testing";

// Fixture repd-synthetic.csv is SYNTHETIC: every project, operator, capacity
// and date is invented. Its layout (group-title row, then the 48-column
// header with quoted, comma-separated X/Y coordinates) follows open-source
// parsers of the REPD quarterly extract; nothing was downloaded from gov.uk.
const REF = fileURLToPath(new URL("./fixtures/reference", import.meta.url));
const ctx = () => testContext(vi.fn(), { REFERENCE_DATA_DIR: REF });
const fixture = () => readFileSync(path.join(REF, "repd", "repd-synthetic.csv"), "utf8");

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "repd-"));
  mkdirSync(path.join(tmp, "repd"), { recursive: true });
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("repd", () => {
  it("parses the extract past the group-title row, converts OSGB36 X/Y to WGS84 and skips Northern Ireland", () => {
    const idx = parseRepd(fixture(), { name: "repd-synthetic.csv", path: "/dev/null", modifiedAt: "x", sizeBytes: 1 });
    expect(idx.projects).toHaveLength(5);
    const solar = idx.projects[0];
    expect(solar).toMatchObject({ ref_id: "9001", site_name: "Synthetic Solar Farm", technology: "Solar Photovoltaics", capacity_mw: 12.5, status_short: "Operational", easting: 529090, northing: 179645, postcode: "ZZ1 1AA", operational: "01/06/2021", mounting_type: "Ground" });
    expect(solar.address).toBe("Synthetic Lane, Testford");
    // SW1A 1AA centroid: 51.501009, -0.141588
    expect(Math.abs(solar.latitude! - 51.501009)).toBeLessThan(0.0002);
    expect(Math.abs(solar.longitude! + 0.141588)).toBeLessThan(0.0002);
    const ni = idx.projects.find((p) => p.ref_id === "9004")!;
    expect(ni).toMatchObject({ country: "Northern Ireland", easting: 330000, latitude: null, longitude: null });
    expect(idx.northernIreland).toBe(1);
    expect(idx.noCoordinates).toBe(1);
    expect(idx.projects.find((p) => p.ref_id === "9005")).toMatchObject({ capacity_mw: 0.4, easting: null, latitude: null });
    expect(idx.projects.find((p) => p.ref_id === "9003")).toMatchObject({ turbines: 3 });
  });

  it("rejects a file without the REPD columns", () => {
    expect(() => parseRepd("Ref ID,Site Name\n1,x\n", { name: "repd-bad.csv", path: "/dev/null", modifiedAt: "x", sizeBytes: 1 })).toThrow(/missing columns/);
  });

  it("finds projects within a radius, nearest first, with technology and status filters", async () => {
    const res = await runOperation(definition, "nearby", { latitude: 51.501, longitude: -0.1416, radius_km: 10 }, ctx());
    expect(res.rows?.map((r) => r.ref_id)).toEqual(["9001", "9002"]);
    expect(res.rows?.[0].distance_km).toBe(0);
    expect(res.rows?.[1].distance_km as number).toBeCloseTo(5, 1);
    expect(res.summary).toContain("2 project(s) within 10 km");
    expect(res.summary).toContain("52.5 MW");
    expect(res.summary).toContain("1 operational");
    expect(res.provenance).toMatchObject({ source: "repd", basis: "measured", licence: "OGL" });
    expect(res.provenance.version).toMatch(/file repd-synthetic\.csv; modified/);
    expect(res.warnings?.some((w) => /1 Northern Ireland projects/.test(w))).toBe(true);

    const battery = await runOperation(definition, "nearby", { latitude: 51.501, longitude: -0.1416, radius_km: 10, technology: "battery" }, ctx());
    expect(battery.rows?.map((r) => r.ref_id)).toEqual(["9002"]);
    const operational = await runOperation(definition, "nearby", { latitude: 51.501, longitude: -0.1416, radius_km: 10, status: "OPERATIONAL" }, ctx());
    expect(operational.rows?.map((r) => r.ref_id)).toEqual(["9001"]);
    const tight = await runOperation(definition, "nearby", { latitude: 51.501, longitude: -0.1416, radius_km: 1 }, ctx());
    expect(tight.rows?.map((r) => r.ref_id)).toEqual(["9001"]);
    const none = await runOperation(definition, "nearby", { latitude: 57.5, longitude: -4.5, radius_km: 5 }, ctx());
    expect(none.rows).toEqual([]);
    expect(none.provenance.basis).toBe("unavailable");
  });

  it("searches by technology, status, area and minimum capacity, largest first", async () => {
    const solar = await runOperation(definition, "search", { technology: "solar" }, ctx());
    expect(solar.rows?.map((r) => r.ref_id)).toEqual(["9001", "9004"]);
    expect(solar.warnings?.some((w) => /Northern Ireland rows/.test(w))).toBe(true);
    const area = await runOperation(definition, "search", { area: "manchester" }, ctx());
    expect(area.rows?.map((r) => r.site_name)).toEqual(["Synthetic Wind Cluster"]);
    const big = await runOperation(definition, "search", { min_capacity_mw: 10, status: "construction" }, ctx());
    expect(big.rows?.map((r) => r.ref_id)).toEqual(["9002"]);
    await expect(runOperation(definition, "search", {}, ctx())).rejects.toThrow(/at least one filter/);
  });

  it("lists loaded extracts with status counts, and handles an empty directory", async () => {
    const res = await runOperation(definition, "files", {}, ctx());
    expect(res.rows?.[0]).toMatchObject({ file: "repd-synthetic.csv", in_use: true, projects: 5, northern_ireland: 1, no_coordinates: 1 });
    expect(String(res.rows?.[0].by_status)).toContain("Operational: 2");
    const empty = await runOperation(definition, "nearby", { latitude: 51.5, longitude: -0.1 }, testContext(vi.fn(), { REFERENCE_DATA_DIR: REF + "/nowhere" }));
    expect(empty.rows).toEqual([]);
    expect(empty.provenance.basis).toBe("unavailable");
    expect(empty.summary).toContain("repd-q2-2026.csv");
  });

  it("downloads the extract from the built-in URL (or an override) and reads it offline afterwards", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(fixture(), { status: 200 }));
    const env = { REFERENCE_DATA_DIR: tmp };
    const res = await runOperation(definition, "download", {}, testContext(fetch, env));
    expect(fetch.mock.calls[0][0]).toBe(DEFAULT_CSV_URL);
    expect(res.rows?.[0]).toMatchObject({ file: "repd-q2-2026.csv", projects: 5, northern_ireland: 1 });
    const override = await runOperation(definition, "download", { url: "https://example.test/repd-q3.csv", name: "repd-q3-2026.csv" }, testContext(fetch, { ...env, REPD_CSV_URL: "https://example.test/ignored.csv" }));
    expect(fetch.mock.calls[1][0]).toBe("https://example.test/repd-q3.csv");
    expect(override.rows?.[0].file).toBe("repd-q3-2026.csv");
    const noNet = vi.fn();
    const nearby = await runOperation(definition, "nearby", { latitude: 51.501, longitude: -0.1416, radius_km: 2 }, testContext(noNet, env));
    expect(noNet).not.toHaveBeenCalled();
    expect(nearby.rows?.map((r) => r.ref_id)).toEqual(["9001"]);
    const bad = vi.fn<FetchLike>(async () => new Response("<html>oops</html>", { status: 200 }));
    await expect(runOperation(definition, "download", {}, testContext(bad, env))).rejects.toThrow(/does not look like a REPD CSV/);
    await expect(runOperation(definition, "download", { name: "../evil.csv" }, testContext(fetch, env))).rejects.toThrow(/must match repd/);
  });

  it("provides links and validates params before any I/O", async () => {
    const fetch = vi.fn();
    const links = await runOperation(definition, "links", {}, testContext(fetch, { REFERENCE_DATA_DIR: REF }));
    expect(links.links?.map((l) => l.url)).toContain("https://www.gov.uk/government/publications/renewable-energy-planning-database-monthly-extract");
    await expect(runOperation(definition, "nearby", { latitude: 95, longitude: 0 }, testContext(fetch, { REFERENCE_DATA_DIR: REF }))).rejects.toThrow();
    await expect(runOperation(definition, "nearby", { latitude: 51, longitude: 0, radius_km: 500 }, testContext(fetch, { REFERENCE_DATA_DIR: REF }))).rejects.toThrow();
    await expect(runOperation(definition, "search", { technology: "solar", limit: 999 }, testContext(fetch, { REFERENCE_DATA_DIR: REF }))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(definition.status).toBe("built_unverified");
  });
});
