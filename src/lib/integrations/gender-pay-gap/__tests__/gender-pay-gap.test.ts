// Fixture CSVs follow the column list documented on the service's download page; not a live download.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { definition, findEmployers, parseGpgCsv } from "..";
import { runOperation, testContext } from "../../testing";

const fx = (n: string) => path.join(__dirname, "fixtures", n);
let dir: string;
let env: Record<string, string>;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "gpg-"));
  env = { REFERENCE_DATA_DIR: dir };
  mkdirSync(path.join(dir, "gender-pay-gap"), { recursive: true });
  copyFileSync(fx("2023.csv"), path.join(dir, "gender-pay-gap", "2023.csv"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("gender-pay-gap", () => {
  it("parses the CSV, keeping blanks as null", () => {
    const records = parseGpgCsv(readFileSync(fx("2024.csv"), "utf8"));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ employer_name: "EXAMPLE FACILITIES LIMITED", company_number: "12345678", mean_hourly_gap_pct: 14.2, median_hourly_gap_pct: 9.5, submitted_after_deadline: false });
    expect(records[1].mean_bonus_gap_pct).toBeNull();
    expect(records[1].submitted_after_deadline).toBe(true);
  });

  it("finds by company number (zero-padded) or name fragment", () => {
    const records = parseGpgCsv(readFileSync(fx("2024.csv"), "utf8"));
    expect(findEmployers(records, "6")[0].employer_name).toBe("NORTHERN WIDGETS PLC");
    expect(findEmployers(records, "facilities group")).toHaveLength(1);
    expect(findEmployers(records, "nothing here")).toEqual([]);
  });

  it("downloads a year from the documented URL and then looks it up offline", async () => {
    const fetch = vi.fn(async () => new Response(readFileSync(fx("2024.csv"), "utf8"), { status: 200 }));
    const reload = await runOperation(definition, "reload", { year: 2024 }, testContext(fetch, env));
    expect(fetch.mock.calls[0][0]).toBe("https://gender-pay-gap.service.gov.uk/viewing/download-data/2024");
    expect(reload.rows?.[0]).toMatchObject({ year: 2024, reports: 2 });

    const noNet = vi.fn();
    const result = await runOperation(definition, "lookup", { year: 2024, query: "12345678" }, testContext(noNet, env));
    expect(noNet).not.toHaveBeenCalled();
    expect(result.rows?.[0]).toMatchObject({ reporting_year: "2024/25", median_hourly_gap_pct: 9.5 });
    expect(result.summary).toContain("median hourly gap 9.5%");
    expect(result.provenance).toMatchObject({ source: "gender-pay-gap", basis: "client_declared", licence: "OGL" });
  });

  it("compares an employer across loaded years", async () => {
    const result = await runOperation(definition, "compare", { query: "example facilities" }, testContext(vi.fn(), env));
    expect(result.rows?.map((r) => r.reporting_year)).toEqual(["2023/24", "2024/25"]);
    expect(result.summary).toContain("from 11.3% to 9.5%");
  });

  it("returns an empty unavailable result for an unknown employer and rejects a bad year before any I/O", async () => {
    const result = await runOperation(definition, "lookup", { year: 2024, query: "zzz" }, testContext(vi.fn(), env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    const fetch = vi.fn();
    await expect(runOperation(definition, "reload", { year: 1999 }, testContext(fetch, env))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
