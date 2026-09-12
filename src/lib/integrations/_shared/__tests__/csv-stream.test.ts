import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCsv } from "../csv";
import { peekCsvRows, scanCsv, streamCsvRows } from "../csv-stream";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nzc-csv-stream-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function collect(p: string, highWaterMark?: number): Promise<string[][]> {
  const out: string[][] = [];
  for await (const row of streamCsvRows(p, { highWaterMark })) out.push(row);
  return out;
}

describe("streamCsvRows", () => {
  const text = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n1,,3\n"trailing ""q""",2,3';

  it("matches parseCsv regardless of chunk boundaries", async () => {
    const p = path.join(dir, "mixed.csv");
    writeFileSync(p, text);
    const expected = parseCsv(text);
    for (const hwm of [1, 2, 3, 5, 7, 64, 1 << 20]) {
      expect(await collect(p, hwm)).toEqual(expected);
    }
  });

  it("handles a file ending in a newline and an empty file", async () => {
    const p = path.join(dir, "nl.csv");
    writeFileSync(p, "id,v\n1,2\n");
    expect(await collect(p, 3)).toEqual([
      ["id", "v"],
      ["1", "2"],
    ]);
    const e = path.join(dir, "empty.csv");
    writeFileSync(e, "");
    expect(await collect(e)).toEqual([]);
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const p = path.join(dir, "utf8.csv");
    writeFileSync(p, "area,name\n12.5,Total floor area (m²)\n");
    expect((await collect(p, 1))[1]).toEqual(["12.5", "Total floor area (m²)"]);
  });
});

describe("scanCsv", () => {
  it("skips a preamble to the header, visits data rows and can stop early", async () => {
    const p = path.join(dir, "preamble.csv");
    writeFileSync(p, "Group titles,,\nRef ID,Site Name,X\n\n1,Alpha,10\n2,Beta,20\n3,Gamma,30\n");
    const seen: string[] = [];
    const result = await scanCsv(p, { isHeader: (row) => row[0] === "Ref ID", highWaterMark: 4 }, (row) => {
      seen.push(row[1]);
      return row[0] !== "2";
    });
    expect(result.header).toEqual(["Ref ID", "Site Name", "X"]);
    expect(result.headerRowIndex).toBe(1);
    expect(seen).toEqual(["Alpha", "Beta"]);
    expect(result.stopped).toBe(true);
    expect(result.rows).toBe(2);
  });

  it("throws when no header is found", async () => {
    const p = path.join(dir, "noheader.csv");
    writeFileSync(p, "a,b\nc,d\n");
    await expect(scanCsv(p, { isHeader: () => false, maxHeaderSearch: 2 }, () => undefined)).rejects.toThrow(/no header row/);
  });
});

describe("peekCsvRows", () => {
  it("returns leading rows without reading the whole file, dropping a truncated last row", () => {
    const p = path.join(dir, "peek.csv");
    writeFileSync(p, "h1,h2\n" + "x".repeat(50) + ",y\n" + "z,w\n");
    expect(peekCsvRows(p, 20)).toEqual([["h1", "h2"]]);
    expect(peekCsvRows(p)).toEqual([
      ["h1", "h2"],
      ["x".repeat(50), "y"],
      ["z", "w"],
    ]);
  });
});
