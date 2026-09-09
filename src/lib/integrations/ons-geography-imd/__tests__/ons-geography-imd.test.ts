import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IMD_URLS, definition, lookupPostcode, parseImd } from "..";
import type { FetchLike } from "../../framework";
import { runOperation, testContext } from "../../testing";

// Fixture files under fixtures/reference/ons-geography-imd/ are SYNTHETIC:
// the LSOA codes (E01099901 ...), names, scores, ranks, deciles and the
// ZZ1/ZS1/ZY1 postcodes are invented. Column names follow the IoD2019 and
// IoD2025 File 7 headers and the ONSPD column order as documented by
// open-source users; nothing was downloaded from gov.uk or ONS here.
const REF = fileURLToPath(new URL("./fixtures/reference", import.meta.url));
const ctx = () => testContext(vi.fn(), { REFERENCE_DATA_DIR: REF });

let imdOnly: string;
let tmp: string;
beforeAll(() => {
  imdOnly = mkdtempSync(path.join(tmpdir(), "imd-only-"));
  mkdirSync(path.join(imdOnly, "ons-geography-imd"), { recursive: true });
  copyFileSync(path.join(REF, "ons-geography-imd", "imd2019-file7.csv"), path.join(imdOnly, "ons-geography-imd", "imd2019-file7.csv"));
  tmp = mkdtempSync(path.join(tmpdir(), "imd-dl-"));
  mkdirSync(path.join(tmp, "ons-geography-imd"), { recursive: true });
});
afterAll(() => {
  rmSync(imdOnly, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe("ons-geography-imd", () => {
  it("parses File 7 for both editions by normalised column prefix", () => {
    const f = (name: string) => ({ name, path: "/dev/null", modifiedAt: "x", sizeBytes: 1 });
    const idx = parseImd(readFileSync(path.join(REF, "ons-geography-imd", "imd2025-file7.csv"), "utf8"), 2025, f("imd2025-file7.csv"));
    expect(idx.geography).toBe(2021);
    expect(idx.byLsoa.get("E01099951")).toMatchObject({ imd_score: 12.222, imd_rank: 24000, imd_decile: 8, income_decile: 8, education_decile: 7, housing_decile: 4, environment_decile: 4, idaci_decile: null, total_population: 1550 });
    expect(() => parseImd("LSOA code (2011),Name\nE01,x\n", 2019, f("imd2019-file7.csv"))).toThrow(/missing LSOA code/);
  });

  it("returns IMD score, rank, decile and every domain decile for an LSOA in each loaded edition", async () => {
    const res = await runOperation(definition, "lsoa", { lsoa: "e01099901" }, ctx());
    expect(res.rows?.map((r) => r.edition)).toEqual([2019]);
    expect(res.rows?.[0]).toMatchObject({ lsoa_code: "E01099901", lsoa_name: "Testford 001A", lad_name: "Testford", imd_score: 11.111, imd_rank: 25001, imd_decile: 8, income_decile: 8, employment_decile: 9, education_decile: 7, health_decile: 7, crime_decile: 5, housing_decile: 4, environment_decile: 4, idaci_decile: 8, idaopi_decile: 7, income_rank: 26000, total_population: 1500 });
    expect(res.summary).toContain("IMD 2019 decile 8 (rank 25001, score 11.111)");
    expect(res.provenance).toMatchObject({ source: "ons-geography-imd", basis: "measured", licence: "OGL" });
    expect(res.provenance.version).toMatch(/IoD2025; file imd2025-file7\.csv; modified .*\| IoD2019; file imd2019-file7\.csv/);
    const most = await runOperation(definition, "lsoa", { lsoa: "E01099902" }, ctx());
    expect(most.rows?.[0]).toMatchObject({ imd_decile: 1, imd_rank: 1500 });
    const scot = await runOperation(definition, "lsoa", { lsoa: "S01099901" }, ctx());
    expect(scot.rows).toEqual([]);
    expect(scot.provenance.basis).toBe("unavailable");
    expect(scot.summary).toContain("not an English LSOA");
    expect(scot.warnings?.some((w) => /SIMD/.test(w))).toBe(true);
  });

  it("maps a postcode through the ONSPD file to the right LSOA per edition geography", async () => {
    const res = await runOperation(definition, "postcode", { postcode: "zz1 1aa" }, ctx());
    expect(res.rows?.map((r) => [r.edition, r.lsoa_code])).toEqual([
      [2025, "E01099951"],
      [2019, "E01099901"],
      ["ONSPD", "E01099951"],
    ]);
    expect(res.summary).toContain("ZZ11AA is in Testford 002A");
    expect(res.raw).toMatchObject({ postcode: { postcode: "ZZ1 1AA", lsoa11: "E01099901", lsoa21: "E01099951", country: "England", latitude: 51.501, easting: 529090 } });
    expect(res.provenance.version).toContain("ONSPD; file onspd-synthetic.csv");
    expect(res.warnings?.some((w) => /Scotland/.test(w))).toBe(false);
  });

  it("warns for a terminated postcode and for a non-English postcode, and reports an unknown one", async () => {
    const terminated = await runOperation(definition, "postcode", { postcode: "ZZ1 1AC" }, ctx());
    expect(terminated.warnings?.some((w) => /terminated 202001/.test(w))).toBe(true);
    expect(terminated.rows?.[0]).toMatchObject({ edition: 2019, lsoa_code: "E01099902", imd_decile: 1 });
    const scot = await runOperation(definition, "postcode", { postcode: "ZS1 1AA" }, ctx());
    expect(scot.rows?.filter((r) => r.edition !== "ONSPD")).toEqual([]);
    expect(scot.summary).toContain("Scotland");
    expect(scot.warnings?.some((w) => /SIMD/.test(w))).toBe(true);
    const unknown = await runOperation(definition, "postcode", { postcode: "ZZ9 9ZZ" }, ctx());
    expect(unknown.rows).toEqual([]);
    expect(unknown.provenance.basis).toBe("unavailable");
    expect(unknown.summary).toContain("not found");
  });

  it("only scans the per-area split file that can hold the postcode", async () => {
    const zy = await lookupPostcode({ REFERENCE_DATA_DIR: REF }, "ZY1 1AA");
    expect(zy.geo?.lsoa11).toBe("E01099901");
    expect(zy.filesScanned).toEqual(["onspd-synthetic.csv", "onspd-synthetic_ZY.csv"]);
    const zz = await lookupPostcode({ REFERENCE_DATA_DIR: REF }, "ZZ1 1AB");
    expect(zz.filesScanned).toEqual(["onspd-synthetic.csv"]);
  });

  it("without an ONSPD file, points to postcodes.io instead of failing", async () => {
    const res = await runOperation(definition, "postcode", { postcode: "ZZ1 1AA" }, testContext(vi.fn(), { REFERENCE_DATA_DIR: imdOnly }));
    expect(res.rows).toEqual([]);
    expect(res.provenance.basis).toBe("unavailable");
    expect(res.summary).toContain("postcodes-io");
    expect(res.links?.some((l) => l.url === "https://postcodes.io/")).toBe(true);
    const none = await runOperation(definition, "lsoa", { lsoa: "E01099901" }, testContext(vi.fn(), { REFERENCE_DATA_DIR: REF + "/nowhere" }));
    expect(none.rows).toEqual([]);
    expect(none.summary).toContain("imd2019-file7.csv");
  });

  it("lists files, links and downloads File 7 to the reference directory", async () => {
    const files = await runOperation(definition, "files", {}, ctx());
    expect(files.rows?.map((r) => [r.file, r.kind, r.area])).toEqual([
      ["imd2025-file7.csv", "imd", ""],
      ["imd2019-file7.csv", "imd", ""],
      ["onspd-synthetic.csv", "onspd", "all"],
      ["onspd-synthetic_ZY.csv", "onspd", "ZY"],
    ]);
    const links = await runOperation(definition, "links", {}, ctx());
    expect(links.rows?.find((r) => r.label === "IoD2019 File 7 CSV")).toMatchObject({ confidence: "confirmed" });

    const body = readFileSync(path.join(REF, "ons-geography-imd", "imd2019-file7.csv"), "utf8");
    const fetch = vi.fn<FetchLike>(async () => new Response(body, { status: 200 }));
    const env = { REFERENCE_DATA_DIR: tmp };
    const dl = await runOperation(definition, "download", { edition: "2019" }, testContext(fetch, env));
    expect(fetch.mock.calls[0][0]).toBe(IMD_URLS[2019].url);
    expect(dl.rows?.[0]).toMatchObject({ edition: 2019, lsoas: 2, geography: 2011, url_confidence: "confirmed" });
    const noNet = vi.fn();
    const after = await runOperation(definition, "lsoa", { lsoa: "E01099902" }, testContext(noNet, env));
    expect(noNet).not.toHaveBeenCalled();
    expect(after.rows?.[0]).toMatchObject({ imd_decile: 1 });
    const bad = vi.fn<FetchLike>(async () => new Response("<html>", { status: 200 }));
    await expect(runOperation(definition, "download", { edition: "2025" }, testContext(bad, env))).rejects.toThrow(/does not look like/);
  });

  it("validates params before any I/O", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "postcode", { postcode: "nope" }, testContext(fetch, { REFERENCE_DATA_DIR: REF }))).rejects.toThrow();
    await expect(runOperation(definition, "download", { edition: "2015" }, testContext(fetch, { REFERENCE_DATA_DIR: REF }))).rejects.toThrow();
    await expect(runOperation(definition, "lsoa", {}, testContext(fetch, { REFERENCE_DATA_DIR: REF }))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(definition.status).toBe("built_unverified");
  });
});
