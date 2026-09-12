import { describe, expect, it } from "vitest";
import { applyMapping, mappingIssues, suggestMapping, MAX_IMPORT_ROWS } from "../mapping";
import { previewCsv } from "../parse";
import { booleanField, dateField, enumField, numberField, registrationField, type ImportSpec } from "../spec";

// A grey-fleet mileage claim, the messiest sheet a consultancy receives: the
// column names differ from the portal's, dates are UK day-first, mileage
// carries thousands separators, and someone has left a blank row in the middle.
const fleet: ImportSpec = {
  id: "fleet-mileage",
  label: "Grey fleet mileage",
  fields: [
    { name: "registration", label: "Registration", required: true, aliases: ["vrm", "reg no"], parse: registrationField() },
    { name: "journeyDate", label: "Journey date", required: true, aliases: ["date"], parse: dateField() },
    { name: "miles", label: "Distance (miles)", required: true, aliases: ["mileage"], parse: numberField({ min: 0 }) },
    { name: "fuel", label: "Fuel", parse: enumField(["Petrol", "Diesel", "Electric"], { aliases: { ev: "Electric", derv: "Diesel" } }) },
    { name: "business", label: "Business journey", parse: booleanField() },
  ],
  rowCheck: (row) => (row.fuel === "Electric" && typeof row.miles === "number" && row.miles > 500 ? ["500 miles on one electric journey looks wrong; check the odometer readings."] : []),
};

describe("suggestMapping", () => {
  it("matches on name, label and alias regardless of case, punctuation and spacing", () => {
    const headers = ["Reg No.", "  DATE  ", "Mileage", "Fuel", "Business journey?"];
    expect(suggestMapping(fleet, headers)).toEqual({ registration: 0, journeyDate: 1, miles: 2, fuel: 3, business: 4 });
  });

  it("falls back to a contains match", () => {
    const headers = ["Vehicle registration mark", "Journey date (dd/mm/yyyy)", "Total mileage claimed", "Fuel type", "Notes"];
    const m = suggestMapping(fleet, headers);
    expect(m).toMatchObject({ registration: 0, journeyDate: 1, miles: 2, fuel: 3 });
    expect(m.business).toBeNull();
  });

  it("leaves a field unmapped when nothing resembles it", () => {
    const m = suggestMapping(fleet, ["Plate", "When", "How far"]);
    expect(m.miles).toBeNull();
    expect(m.fuel).toBeNull();
  });

  it("never gives one column to two required fields", () => {
    const twoDates: ImportSpec = {
      id: "two-dates",
      label: "Two dates",
      fields: [
        { name: "startDate", label: "Start date", required: true, aliases: ["date"], parse: dateField() },
        { name: "endDate", label: "End date", required: true, aliases: ["date"], parse: dateField() },
      ],
    };
    const m = suggestMapping(twoDates, ["Date"]);
    expect(m.startDate).toBe(0);
    expect(m.endDate).toBeNull();
    expect(mappingIssues(twoDates, m)).toEqual(["End date is required and no column is mapped to it."]);
  });

  it("prefers a required field when a column would suit either", () => {
    const spec: ImportSpec = {
      id: "s",
      label: "s",
      fields: [
        { name: "note", label: "Note", aliases: ["reference"], parse: registrationField() },
        { name: "reference", label: "Reference", required: true, parse: registrationField() },
      ],
    };
    expect(suggestMapping(spec, ["Reference"])).toEqual({ reference: 0, note: null });
  });
});

describe("mappingIssues", () => {
  it("names every unmapped required field", () => {
    const issues = mappingIssues(fleet, { registration: 0, journeyDate: null, miles: null, fuel: null, business: null });
    expect(issues).toEqual(["Journey date is required and no column is mapped to it.", "Distance (miles) is required and no column is mapped to it."]);
  });
  it("flags one column feeding two fields", () => {
    const issues = mappingIssues(fleet, { registration: 0, journeyDate: 1, miles: 1, fuel: null, business: null });
    expect(issues[0]).toContain("One column is mapped to 2 fields (Journey date, Distance (miles))");
  });
  it("is silent on a complete mapping", () => {
    expect(mappingIssues(fleet, { registration: 0, journeyDate: 1, miles: 2, fuel: 3, business: 4 })).toEqual([]);
  });
});

describe("applyMapping", () => {
  const text = [
    "Grey fleet mileage claim",
    "Q1 2024",
    "",
    "Reg No.,Date,Mileage,Fuel,Business journey?",
    "ab12 cde,15/01/2024,\"1,234.5\",Diesel,yes",
    "CD34 EFG,03/04/2024,342 miles,EV,y",
    ",,,,",
    "EF56 GHI,03/15/2024,120,Petrol,no",
    "GH78 IJK,20/01/2024,N/A,Petrol,yes",
    "JK90 LMN,21/01/2024,,Petrol,yes",
    "LM12 NOP,45306,£1 234,DERV,1",
  ].join("\n");

  const run = () => {
    const preview = previewCsv(text);
    const mapping = suggestMapping(fleet, preview.headers);
    return { preview, mapping, result: applyMapping(fleet, preview.headers, preview.rows, mapping) };
  };

  it("parses the rows it understands, day-first and separators included", () => {
    const { result } = run();
    expect(result.rows.map((r) => r.data)).toEqual([
      { registration: "AB12CDE", journeyDate: "2024-01-15", miles: 1234.5, fuel: "Diesel", business: true },
      { registration: "CD34EFG", journeyDate: "2024-04-03", miles: 342, fuel: "Electric", business: true },
      { registration: "LM12NOP", journeyDate: "2024-01-15", miles: 1234, fuel: "Diesel", business: true },
    ]);
  });

  it("drops a wholly blank line before mapping and says how many", () => {
    const { preview, result } = run();
    expect(preview.totalRows).toBe(6);
    expect(preview.warnings.some((w) => w.includes("2 blank lines skipped"))).toBe(true);
    expect(result.skippedBlank).toBe(0);
  });

  it("skips a row whose mapped cells are all blank, and counts it rather than dropping it silently", () => {
    const preview = previewCsv("Reg,Date,Miles,Comment\nAB12CDE,15/01/2024,10,\n,,,chase the site manager\n");
    const mapping = suggestMapping(fleet, preview.headers);
    const result = applyMapping(fleet, preview.headers, preview.rows, mapping);
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toEqual([]);
    expect(result.skippedBlank).toBe(1);
    expect(result.summary).toBe("2 rows, 0 with errors, 1 will be imported, 1 blank row skipped");
  });

  it("turns unreadable rows into errors naming the row, the column and the value", () => {
    const { result } = run();
    const messages = result.errors.map((e) => `${e.rowNumber}|${e.column}|${e.field}|${e.message}`);
    expect(messages).toEqual([
      expect.stringContaining("4|Date|journeyDate|Journey date: \"03/15/2024\" is not a valid date"),
      expect.stringContaining("5|Mileage|miles|Distance (miles): \"N/A\" is not a number"),
      expect.stringContaining("6|Mileage|miles|Distance (miles) is required but the cell is blank"),
    ]);
    expect(messages[0]).toContain("day first");
  });

  it("summarises the counts the way the UI states them", () => {
    const { result } = run();
    expect(result.summary).toBe("6 rows, 3 with errors, 3 will be imported");
  });

  it("reports a required field with no column on every row rather than dropping the rows", () => {
    const preview = previewCsv(text);
    const mapping = { ...suggestMapping(fleet, preview.headers), miles: null };
    const result = applyMapping(fleet, preview.headers, preview.rows, mapping);
    expect(result.rows).toHaveLength(0);
    expect(result.errors.filter((e) => e.field === "miles")).toHaveLength(6);
    expect(result.errors[0].message).toContain("no column is mapped to it");
  });

  it("leaves an unmapped optional field out of the row rather than nulling it", () => {
    const preview = previewCsv(text);
    const mapping = { ...suggestMapping(fleet, preview.headers), fuel: null, business: null };
    const result = applyMapping(fleet, preview.headers, preview.rows, mapping);
    expect(result.rows[0].data).toEqual({ registration: "AB12CDE", journeyDate: "2024-01-15", miles: 1234.5 });
    expect("fuel" in result.rows[0].data).toBe(false);
  });

  it("runs rowCheck once a row's own fields have parsed", () => {
    const preview = previewCsv("Reg,Date,Miles,Fuel\nAB12CDE,15/01/2024,900,EV\n");
    const mapping = suggestMapping(fleet, preview.headers);
    const result = applyMapping(fleet, preview.headers, preview.rows, mapping);
    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]).toMatchObject({ rowNumber: 2, message: "500 miles on one electric journey looks wrong; check the odometer readings." });
  });

  it("caps the import at 20,000 rows and says so", () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 5 }, (_, i) => ["AB12CDE", "15/01/2024", String(i + 1)]);
    const result = applyMapping(fleet, ["Reg", "Date", "Miles"], rows, { registration: 0, journeyDate: 1, miles: 2, fuel: null, business: null });
    expect(result.rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(result.truncated).toBe(true);
    expect(result.errors.at(-1)?.message).toContain("Only the first 20,000 rows were read; 5 further rows were ignored");
    expect(result.summary).toContain("only the first 20,000 of 20,005 rows were read");
  });

  it("numbers rows from the header, so the number matches what the user sees", () => {
    const preview = previewCsv("Reg,Date,Miles\nAB12CDE,15/01/2024,10\nZZ,not a date,10\n");
    const mapping = suggestMapping(fleet, preview.headers);
    const result = applyMapping(fleet, preview.headers, preview.rows, mapping);
    expect(result.rows[0].rowNumber).toBe(2);
    expect(result.errors[0].rowNumber).toBe(3);
  });
});
