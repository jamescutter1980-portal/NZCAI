import { describe, expect, it } from "vitest";
import { csvToRecords, missingColumns, parseCsv, parseNumericCell } from "../csv";

describe("parseCsv", () => {
  it("handles quoted commas, escaped quotes and embedded newlines", () => {
    const text = 'a,b,c\n"x, y","say ""hi""","line1\nline2"\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "line1\nline2"],
    ]);
  });

  it("handles CRLF, a BOM and no trailing newline", () => {
    const text = "﻿id,value\r\n1,2\r\n3,";
    expect(parseCsv(text)).toEqual([
      ["id", "value"],
      ["1", "2"],
      ["3", ""],
    ]);
  });

  it("keeps blank cells as empty strings rather than dropping them", () => {
    expect(parseCsv("a,,c\n,,\n")).toEqual([
      ["a", "", "c"],
      ["", "", ""],
    ]);
  });
});

describe("csvToRecords", () => {
  it("skips preamble rows when a header predicate is given and ignores empty rows", () => {
    const text = "Some title\n\nID,Name\n1,alpha\n\n2,beta\n";
    const t = csvToRecords(text, { isHeader: (r) => r[0] === "ID" });
    expect(t.headerRowIndex).toBe(2);
    expect(t.records).toEqual([
      { ID: "1", Name: "alpha" },
      { ID: "2", Name: "beta" },
    ]);
  });

  it("fills missing trailing cells with empty strings", () => {
    const t = csvToRecords("a,b,c\n1\n");
    expect(t.records[0]).toEqual({ a: "1", b: "", c: "" });
  });

  it("throws when there is no header", () => {
    expect(() => csvToRecords("\n\n")).toThrow();
  });
});

describe("parseNumericCell", () => {
  it("returns null for blank and non-numeric text, never 0", () => {
    expect(parseNumericCell("")).toBeNull();
    expect(parseNumericCell("  ")).toBeNull();
    expect(parseNumericCell(undefined)).toBeNull();
    expect(parseNumericCell("N/A")).toBeNull();
    expect(parseNumericCell("-")).toBeNull();
    expect(parseNumericCell("ND")).toBeNull();
  });

  it("parses zero, decimals, negatives, thousands separators and exponents", () => {
    expect(parseNumericCell("0")).toBe(0);
    expect(parseNumericCell("0.00")).toBe(0);
    expect(parseNumericCell("1.111")).toBe(1.111);
    expect(parseNumericCell("-2.5")).toBe(-2.5);
    expect(parseNumericCell("1,234.5")).toBe(1234.5);
    expect(parseNumericCell("1e-3")).toBe(0.001);
  });
});

describe("missingColumns", () => {
  it("is case-insensitive", () => {
    expect(missingColumns(["Year", "Value"], ["year", "unit"])).toEqual(["unit"]);
  });
});
