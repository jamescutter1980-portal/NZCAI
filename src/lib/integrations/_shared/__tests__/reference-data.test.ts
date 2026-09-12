import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clearReferenceCache, fileVersion, listReferenceFiles, loadReferenceCsv, parseYearSeries, referenceDir, referenceHealth } from "../reference-data";

describe("reference-data", () => {
  it("resolves the directory from ctx.env with a default", () => {
    expect(referenceDir({}, "x")).toBe(path.resolve("data/reference", "x"));
    expect(referenceDir({ REFERENCE_DATA_DIR: "/tmp/ref" }, "x")).toBe(path.resolve("/tmp/ref/x"));
  });

  it("lists matching files, loads them once per mtime and reports health", async () => {
    clearReferenceCache();
    const base = mkdtempSync(path.join(tmpdir(), "nzc-ref-"));
    const dir = path.join(base, "demo");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "2025.csv"), "year,value\n2025,1.111\n");
    writeFileSync(path.join(dir, "notes.txt"), "ignored");
    const env = { REFERENCE_DATA_DIR: base };
    const files = listReferenceFiles(env, "demo", /^\d{4}\.csv$/);
    expect(files.map((f) => f.name)).toEqual(["2025.csv"]);
    expect(fileVersion(files[0], "2025")).toMatch(/^2025; file 2025\.csv; modified \d{4}-/);

    const t1 = loadReferenceCsv(files[0]);
    expect(t1.records).toEqual([{ year: "2025", value: "1.111" }]);
    // Same mtime + size -> cached object
    expect(loadReferenceCsv(files[0])).toBe(t1);

    // Change the file and its mtime -> reloaded
    writeFileSync(path.join(dir, "2025.csv"), "year,value\n2025,2.222\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(path.join(dir, "2025.csv"), later, later);
    const files2 = listReferenceFiles(env, "demo", /^\d{4}\.csv$/);
    expect(loadReferenceCsv(files2[0]).records[0].value).toBe("2.222");

    const health = referenceHealth("demo", /^\d{4}\.csv$/, "<year>.csv");
    const ctx = { fetch: async () => new Response(""), env, now: () => new Date() };
    expect((await health(ctx)).ok).toBe(true);
    expect((await health({ ...ctx, env: { REFERENCE_DATA_DIR: path.join(base, "missing") } })).ok).toBe(false);
  });

  it("parses year series from lines, JSON arrays and objects", () => {
    expect(parseYearSeries("year,value\n2030, 50\n2025,60")).toEqual([
      { year: 2025, value: 60 },
      { year: 2030, value: 50 },
    ]);
    expect(parseYearSeries('[{"year":2025,"value":1.5},[2026,1.4]]')).toEqual([
      { year: 2025, value: 1.5 },
      { year: 2026, value: 1.4 },
    ]);
    expect(parseYearSeries('{"2025": 3}')).toEqual([{ year: 2025, value: 3 }]);
    expect(parseYearSeries("")).toEqual([]);
    expect(() => parseYearSeries("2025,abc")).toThrow();
    expect(() => parseYearSeries("2025,1\n2025,2")).toThrow(/more than once/);
  });
});
