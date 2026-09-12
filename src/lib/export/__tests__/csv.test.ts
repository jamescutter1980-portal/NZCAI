import { describe, expect, it } from "vitest";
import { csvField, csvRow, looksLikeFormula, safeFilename, toCsv, UTF8_BOM } from "..";

describe("csvField", () => {
  it("leaves plain text alone", () => {
    expect(csvField("Alpha House")).toBe("Alpha House");
    expect(csvField("1000000000001")).toBe("1000000000001");
  });

  it("quotes fields containing a comma", () => {
    expect(csvField("Beta Depot, Unit 4")).toBe('"Beta Depot, Unit 4"');
  });

  it("quotes and doubles embedded quotes", () => {
    expect(csvField('The "Old" Mill')).toBe('"The ""Old"" Mill"');
    expect(csvField('"')).toBe('""""');
  });

  it("quotes fields containing CR or LF", () => {
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
    expect(csvField("line one\r\nline two")).toBe('"line one\r\nline two"');
    expect(csvField("bare\rreturn")).toBe('"bare\rreturn"');
  });

  it("guards text Excel would evaluate as a formula", () => {
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(csvField('=HYPERLINK("http://x","go")')).toBe(`"'=HYPERLINK(""http://x"",""go"")"`);
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvField("+44 20 7000 0000")).toBe("'+44 20 7000 0000");
    expect(csvField("=1+1", { guardFormulas: false })).toBe("=1+1");
  });

  it("does not guard numbers or numeric text, so negatives survive", () => {
    expect(csvField(-12.5)).toBe("-12.5");
    expect(csvField("-12.5")).toBe("-12.5");
    expect(csvField("-1e-3")).toBe("-1e-3");
    expect(looksLikeFormula("-12.5")).toBe(false);
    expect(looksLikeFormula("-SUM")).toBe(true);
  });

  it("writes numbers unformatted and blanks the unavailable", () => {
    expect(csvField(1234567.891)).toBe("1234567.891");
    expect(csvField(0)).toBe("0");
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField(Number.NaN)).toBe("");
    expect(csvField(Number.POSITIVE_INFINITY)).toBe("");
    expect(csvField(true)).toBe("yes");
    expect(csvField(false)).toBe("no");
  });
});

describe("csvRow and toCsv", () => {
  it("joins fields with commas", () => {
    expect(csvRow(["a", 1, null, "b,c"])).toBe('a,1,,"b,c"');
  });

  it("uses CRLF line endings and a trailing terminator", () => {
    expect(toCsv(["a", "b"], [[1, 2], [3, 4]])).toBe("a,b\r\n1,2\r\n3,4\r\n");
  });

  it("writes a header-only file when there are no rows", () => {
    expect(toCsv(["a", "b"], [])).toBe("a,b\r\n");
  });

  it("prepends a UTF-8 BOM only when asked", () => {
    const withBom = toCsv(["a"], [["£1"]], { bom: true });
    expect(withBom.startsWith(UTF8_BOM)).toBe(true);
    expect(Buffer.from(withBom, "utf8").subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(toCsv(["a"], [["£1"]]).startsWith(UTF8_BOM)).toBe(false);
  });

  it("round-trips a quoted field through a naive parser", () => {
    const csv = toCsv(["name"], [['Beta, "Old" Mill\nUnit 4']]);
    const body = csv.slice(csv.indexOf("\r\n") + 2, -2);
    expect(body.slice(1, -1).replace(/""/g, '"')).toBe('Beta, "Old" Mill\nUnit 4');
  });
});

describe("safeFilename", () => {
  it("strips anything that would break a header or a filesystem", () => {
    expect(safeFilename('asset-carbon-Beta, "Old" Mill-2025')).toBe("asset-carbon-Beta-Old-Mill-2025.csv");
    expect(safeFilename("../../etc/passwd")).toBe("etc-passwd.csv");
    expect(safeFilename("")).toBe("export.csv");
    expect(safeFilename("readings", "txt")).toBe("readings.txt");
  });
});
