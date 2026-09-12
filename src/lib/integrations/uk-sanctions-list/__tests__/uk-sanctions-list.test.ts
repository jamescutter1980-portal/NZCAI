// The fixture CSV follows the GOV.UK "Format guide for the UK Sanctions List"
// column layout as reproduced by open-source consumers; it was not taken from a live download.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { definition, parseSanctionsCsv, screenName, similarity } from "..";
import type { FetchLike } from "../../framework";
import { runOperation, testContext } from "../../testing";

const fixture = readFileSync(path.join(__dirname, "fixtures", "UK_Sanctions_List.csv"), "utf8");
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "uksl-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("uk-sanctions-list", () => {
  it("parses the CSV into designations with aliases, regimes and the publication date", () => {
    const list = parseSanctionsCsv(fixture);
    expect(list.publicationDate).toBe("05/09/2026");
    expect(list.rowCount).toBe(6);
    expect(list.designations).toHaveLength(3);
    const rus = list.designations.find((d) => d.id === "RUS0001");
    expect(rus).toMatchObject({ primaryName: "Example Trading Company LLC", aliases: ["OOO Example Trading"], type: "Entity", dateDesignated: "15/03/2022" });
    expect(rus?.regimes).toHaveLength(2);
    const syr = list.designations.find((d) => d.id === "SYR0337");
    expect(syr).toMatchObject({ primaryName: "Ahmad Sami Al-Example", aliases: ["Ahmed Samy Alexample"], type: "Individual" });
  });

  it("scores names case-insensitively and ignores corporate suffixes", () => {
    expect(similarity("example trading company", "Example Trading Company LLC")).toBeGreaterThanOrEqual(0.9);
    expect(similarity("EXAMPLE TRADING COMPANY LLC", "Example Trading Company LLC")).toBe(1);
    expect(similarity("Focus Green Ltd", "Example Trading Company LLC")).toBeLessThan(0.3);
    const matches = screenName(parseSanctionsCsv(fixture), "ooo example trading", 0.6, 10);
    expect(matches[0].designation.id).toBe("RUS0001");
    expect(matches[0].score).toBe(1);
    expect(screenName(parseSanctionsCsv(fixture), "Ahmed Samy Alexample", 0.6, 10)[0].matchedName).toBe("Ahmed Samy Alexample");
  });

  it("downloads to the reference directory on reload, then screens without the network", async () => {
    const env = { REFERENCE_DATA_DIR: dir, UK_SANCTIONS_LIST_URL: "https://example.test/list.csv" };
    const fetch = vi.fn<FetchLike>(async () => new Response(fixture, { status: 200, headers: { "content-type": "text/csv" } }));
    const reload = await runOperation(definition, "reload", {}, testContext(fetch, env));
    expect(fetch.mock.calls[0][0]).toBe("https://example.test/list.csv");
    expect(reload.summary).toContain("6 rows");
    expect(reload.summary).toContain("05/09/2026");
    expect(reload.rows).toContainEqual({ type: "Entity", designations: 1 });

    const noNet = vi.fn();
    const result = await runOperation(definition, "screen", { name: "Example Trading Company" }, testContext(noNet, env));
    expect(noNet).not.toHaveBeenCalled();
    expect(result.rows?.[0]).toMatchObject({ unique_id: "RUS0001", type: "Entity" });
    expect(result.warnings?.[0]).toMatch(/human review/);
    expect(result.provenance).toMatchObject({ source: "uk-sanctions-list", basis: "measured", licence: "OGL" });
    expect(result.provenance.version).toContain("published 05/09/2026");
  });

  it("returns an empty unavailable result when nothing matches", async () => {
    const env = { REFERENCE_DATA_DIR: dir };
    const result = await runOperation(definition, "screen", { name: "Focus Green Limited", min_score: 0.8 }, testContext(vi.fn(), env));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
  });

  it("explains how to load the list when no file is present and rejects an empty name before reading", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "uksl-empty-"));
    try {
      await expect(runOperation(definition, "screen", { name: "x" }, testContext(vi.fn(), { REFERENCE_DATA_DIR: empty }))).rejects.toThrow(/reload/);
      await expect(runOperation(definition, "screen", { min_score: 5 }, testContext(vi.fn(), { REFERENCE_DATA_DIR: dir }))).rejects.toThrow();
      const health = await definition.healthCheck!(testContext(vi.fn(), { REFERENCE_DATA_DIR: empty }));
      expect(health.ok).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
