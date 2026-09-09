// Fixture columns follow the export as parsed by open-source scripts; not a live download.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { definition, findReports, parsePaymentCsv } from "..";
import { runOperation, testContext } from "../../testing";

const fixture = readFileSync(path.join(__dirname, "fixtures", "payment-practices.csv"), "utf8");
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ppr-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("payment-practices-reporting", () => {
  it("parses reports with blanks as null and sorts latest period first", () => {
    const rows = parsePaymentCsv(fixture);
    expect(rows).toHaveLength(3);
    expect(rows[2].pct_not_paid_within_agreed_terms).toBeNull();
    const hits = findReports(rows, "12345678");
    expect(hits.map((h) => h.period_end)).toEqual(["30/06/2025", "31/12/2024"]);
    expect(findReports(rows, "northern")[0]).toMatchObject({ average_days_to_pay: 44, e_invoicing_offered: false });
  });

  it("downloads the export and searches offline", async () => {
    const env = { REFERENCE_DATA_DIR: dir, PAYMENT_PRACTICES_CSV_URL: "https://example.test/export.csv" };
    const fetch = vi.fn(async () => new Response(fixture, { status: 200 }));
    const reload = await runOperation(definition, "reload", {}, testContext(fetch, env));
    expect(fetch.mock.calls[0][0]).toBe("https://example.test/export.csv");
    expect(reload.rows?.[0]).toMatchObject({ reports: 3, companies: 2 });

    const noNet = vi.fn();
    const result = await runOperation(definition, "search", { query: "Example Facilities" }, testContext(noNet, env));
    expect(noNet).not.toHaveBeenCalled();
    expect(result.rows).toHaveLength(2);
    expect(result.summary).toContain("34 days on average, 58% within 30 days, 21% not within agreed terms");
    expect(result.provenance).toMatchObject({ source: "payment-practices-reporting", basis: "client_declared", licence: "OGL" });
  });

  it("returns an empty unavailable result for an unknown company and fails clearly when the export is absent", async () => {
    const result = await runOperation(definition, "search", { query: "no such company" }, testContext(vi.fn(), { REFERENCE_DATA_DIR: dir }));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    const empty = mkdtempSync(path.join(tmpdir(), "ppr-empty-"));
    try {
      await expect(runOperation(definition, "search", { query: "x" }, testContext(vi.fn(), { REFERENCE_DATA_DIR: empty }))).rejects.toThrow(/reload/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("rejects a download that is not the export", async () => {
    const fetch = vi.fn(async () => new Response("<html>login</html>", { status: 200 }));
    await expect(runOperation(definition, "reload", {}, testContext(fetch, { REFERENCE_DATA_DIR: dir }))).rejects.toThrow(/does not look like/);
  });
});
