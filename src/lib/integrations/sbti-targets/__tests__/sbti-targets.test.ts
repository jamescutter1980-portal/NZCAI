// The fixture is a user-saved CSV with the column names the connector documents; the SBTi export itself has no fixed schema here.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { definition } from "..";
import { runOperation, testContext } from "../../testing";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sbti-"));
  mkdirSync(path.join(dir, "sbti-targets"), { recursive: true });
  copyFileSync(path.join(__dirname, "fixtures", "targets.csv"), path.join(dir, "sbti-targets", "targets.csv"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("sbti-targets", () => {
  it("is reference-only and returns dashboard links without the network", async () => {
    expect(definition.status).toBe("reference_only");
    const fetch = vi.fn();
    const result = await runOperation(definition, "links", {}, testContext(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.links?.[0].url).toBe("https://sciencebasedtargets.org/target-dashboard");
    expect(result.provenance.basis).toBe("not_applicable");
  });

  it("searches the user-saved export by name, ISIN or LEI", async () => {
    const env = { REFERENCE_DATA_DIR: dir };
    const byName = await runOperation(definition, "search", { query: "example facilities" }, testContext(vi.fn(), env));
    expect(byName.rows?.[0]).toMatchObject({ near_term_status: "Targets set", near_term_target_year: "2030" });
    expect(byName.summary).toContain("target year 2030");
    const byLei = await runOperation(definition, "search", { query: "213800EXAMPLELEI000001" }, testContext(vi.fn(), env));
    expect(byLei.rows).toHaveLength(1);
    const none = await runOperation(definition, "search", { query: "nobody" }, testContext(vi.fn(), env));
    expect(none.rows).toEqual([]);
    expect(none.provenance.basis).toBe("unavailable");
  });

  it("explains where to put the file when absent", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "sbti-empty-"));
    try {
      await expect(runOperation(definition, "search", { query: "x" }, testContext(vi.fn(), { REFERENCE_DATA_DIR: empty }))).rejects.toThrow(/targets\.csv/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
