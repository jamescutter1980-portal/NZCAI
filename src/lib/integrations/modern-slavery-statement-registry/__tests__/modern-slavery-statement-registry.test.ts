// Fixture columns follow those used by open-source consumers of the registry's StatementSummaries CSV; not a live download.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { definition, findStatements, parseStatementsCsv } from "..";
import { runOperation, testContext } from "../../testing";

const fixture = readFileSync(path.join(__dirname, "fixtures", "StatementSummaries2025.csv"), "utf8");
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "msr-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("modern-slavery-statement-registry", () => {
  it("parses statement summaries", () => {
    const rows = parseStatementsCsv(fixture);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ organisation: "EXAMPLE FACILITIES LIMITED", company_number: "12345678", statement_year: "2025", turnover_band: "£36 million to £60 million", period_end: "31/03/2025" });
    expect(findStatements(rows, "6")[0].organisation).toBe("NORTHERN WIDGETS PLC");
    expect(findStatements(rows, "example facilities")).toHaveLength(1);
  });

  it("downloads a year from the documented URL and searches offline", async () => {
    const env = { REFERENCE_DATA_DIR: dir };
    const fetch = vi.fn(async () => new Response(fixture, { status: 200 }));
    const reload = await runOperation(definition, "reload", { year: 2025 }, testContext(fetch, env));
    expect(fetch.mock.calls[0][0]).toBe("https://downloads.modern-slavery-statement-registry.service.gov.uk/publicdownloads/StatementSummaries2025.csv");
    expect(reload.rows?.[0]).toMatchObject({ year: 2025, statements: 2 });

    const noNet = vi.fn();
    const result = await runOperation(definition, "search", { query: "12345678" }, testContext(noNet, env));
    expect(noNet).not.toHaveBeenCalled();
    expect(result.rows?.[0]).toMatchObject({ organisation: "EXAMPLE FACILITIES LIMITED", statement_year: "2025" });
    expect(result.warnings?.[0]).toMatch(/not of performance/);
    expect(result.provenance).toMatchObject({ source: "modern-slavery-statement-registry", basis: "client_declared", licence: "OGL" });
  });

  it("returns an empty unavailable result when nothing matches and rejects a bad year before the network", async () => {
    const env = { REFERENCE_DATA_DIR: dir };
    const result = await runOperation(definition, "search", { query: "no such org", year: 2025 }, testContext(vi.fn(), env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    const fetch = vi.fn();
    await expect(runOperation(definition, "reload", { year: 2000 }, testContext(fetch, env))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
