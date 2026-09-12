import { describe, expect, it } from "vitest";
import { detectDelimiter, looksLikeHeaderRow, previewCsv } from "../parse";

// Fixtures are invented but shaped like files consultancy clients actually
// send: an Excel title block above the table, a stray blank line, a column the
// exporter named twice, and a row someone added a note to.

describe("previewCsv delimiter detection", () => {
  const rows = [
    ["Site", "Meter", "kWh"],
    ["Head office", "1200012345678", "18450"],
    ["Depot", "1200087654321", "9320"],
  ];
  const build = (d: string) => rows.map((r) => r.join(d)).join("\n");

  it("detects a comma", () => {
    const p = previewCsv(build(","));
    expect(p.delimiter).toBe(",");
    expect(p.headers).toEqual(["Site", "Meter", "kWh"]);
    expect(p.rows).toHaveLength(2);
  });

  it("detects a semicolon, as European Excel writes it", () => {
    const p = previewCsv(build(";"));
    expect(p.delimiter).toBe(";");
    expect(p.headers).toEqual(["Site", "Meter", "kWh"]);
    expect(p.rows[1]).toEqual(["Depot", "1200087654321", "9320"]);
  });

  it("detects a tab", () => {
    const p = previewCsv(build("\t"));
    expect(p.delimiter).toBe("\t");
    expect(p.rows[0]).toEqual(["Head office", "1200012345678", "18450"]);
  });

  it("detects a pipe", () => {
    const p = previewCsv(build("|"));
    expect(p.delimiter).toBe("|");
    expect(p.headers).toHaveLength(3);
  });

  it("is not fooled by commas inside quoted fields of a semicolon file", () => {
    const text = 'Site;Address;kWh\r\nHead office;"12 High Street, Leeds";18,450\r\nDepot;"Unit 3, Trading Estate";9,320\r\n';
    expect(detectDelimiter(text)).toBe(";");
    const p = previewCsv(text);
    expect(p.rows[0]).toEqual(["Head office", "12 High Street, Leeds", "18,450"]);
  });

  it("falls back to a comma for a single-column file", () => {
    expect(previewCsv("Registration\nAB12CDE\nCD34EFG\n").delimiter).toBe(",");
  });
});

describe("previewCsv structure", () => {
  it("strips a UTF-8 BOM from the first header name", () => {
    const p = previewCsv("﻿Site,kWh\nDepot,120\n");
    expect(p.headers).toEqual(["Site", "kWh"]);
    expect(p.rows).toEqual([["Depot", "120"]]);
  });

  it("skips preamble rows above the real header", () => {
    const text = ["Half-hourly consumption export", "Client: Acme Ltd", "Generated 03/04/2026", "", "Site,Read date,kWh", "Head office,15/01/2024,1820", "Depot,15/01/2024,940"].join("\n");
    const p = previewCsv(text);
    expect(p.preambleRows).toBe(3);
    expect(p.headers).toEqual(["Site", "Read date", "kWh"]);
    expect(p.rows).toHaveLength(2);
    expect(p.warnings.some((w) => w.includes("skipped as preamble"))).toBe(true);
  });

  it("does not mistake a row of values for the header", () => {
    const text = "2024-01-15,18450,Head office\nSite,kWh,Name\n";
    // The first row is all values, so the second row is the header.
    expect(previewCsv(text).headers).toEqual(["Site", "kWh", "Name"]);
  });

  it("skips fully blank lines wherever they appear", () => {
    const p = previewCsv("Site,kWh\n\nDepot,940\n\n\nHead office,1820\n\n");
    expect(p.rows).toEqual([["Depot", "940"], ["Head office", "1820"]]);
    expect(p.totalRows).toBe(2);
    expect(p.warnings.some((w) => w.includes("blank line"))).toBe(true);
  });

  it("de-duplicates repeated header names", () => {
    const p = previewCsv("Site,kWh,kWh,Notes\nDepot,940,960,check\n");
    expect(p.headers).toEqual(["Site", "kWh", "kWh (2)", "Notes"]);
    expect(p.warnings.some((w) => w.includes('repeats the name "kWh"'))).toBe(true);
  });

  it("names an unnamed header column", () => {
    const p = previewCsv("Site,,kWh\nDepot,x,940\n");
    expect(p.headers).toEqual(["Site", "Column 2", "kWh"]);
  });

  it("warns about ragged rows instead of throwing", () => {
    const text = "Site,Read date,kWh\nDepot,15/01/2024,940,added by hand\nHead office,15/01/2024\nWarehouse,15/01/2024,1200\n";
    const p = previewCsv(text);
    expect(p.rows).toHaveLength(3);
    expect(p.rows[0]).toEqual(["Depot", "15/01/2024", "940"]);
    expect(p.rows[1]).toEqual(["Head office", "15/01/2024", ""]);
    expect(p.warnings.some((w) => w.includes("Row 2") && w.includes('"added by hand"'))).toBe(true);
    expect(p.warnings.some((w) => w.includes("Row 3") && w.includes("read as blank"))).toBe(true);
  });

  it("truncates with a stated count and keeps the true total", () => {
    const text = ["Site,kWh", ...Array.from({ length: 50 }, (_, i) => `Site ${i},${i}`)].join("\n");
    const p = previewCsv(text, { maxRows: 20 });
    expect(p.rows).toHaveLength(20);
    expect(p.totalRows).toBe(50);
    expect(p.truncated).toBe(true);
    expect(p.warnings.some((w) => w.includes("Only the first 20 of 50 rows"))).toBe(true);
  });

  it("reports an empty paste rather than throwing", () => {
    const p = previewCsv("   \n\n");
    expect(p.headers).toEqual([]);
    expect(p.totalRows).toBe(0);
    expect(p.warnings[0]).toContain("nothing to read");
  });

  it("handles CRLF and a trailing newline", () => {
    const p = previewCsv("Site,kWh\r\nDepot,940\r\n");
    expect(p.rows).toEqual([["Depot", "940"]]);
  });
});

describe("looksLikeHeaderRow", () => {
  it("accepts a row of distinct names", () => {
    expect(looksLikeHeaderRow(["Site", "Read date", "kWh"], 3)).toBe(true);
  });
  it("rejects a row of values", () => {
    expect(looksLikeHeaderRow(["Depot", "15/01/2024", "940"], 3)).toBe(false);
  });
  it("rejects a narrow title row", () => {
    expect(looksLikeHeaderRow(["Consumption export"], 4)).toBe(false);
  });
  it("rejects a row of repeated names", () => {
    expect(looksLikeHeaderRow(["kWh", "kWh", "kWh", "kWh"], 4)).toBe(false);
  });
});
