import { describe, expect, it } from "vitest";
import { booleanField, dateField, enumField, integerField, numberField, registrationField, templateCsv, textField, type FieldParse } from "../spec";

const value = <V,>(p: FieldParse<V>, raw: string): V => {
  const r = p(raw, {});
  if (!r.ok) throw new Error(`expected ${JSON.stringify(raw)} to parse, got: ${r.error}`);
  return r.value;
};
const error = <V,>(p: FieldParse<V>, raw: string): string => {
  const r = p(raw, {});
  if (r.ok) throw new Error(`expected ${JSON.stringify(raw)} to fail, got: ${JSON.stringify(r.value)}`);
  return r.error;
};

describe("textField", () => {
  const f = textField();
  it("trims and collapses whitespace", () => {
    expect(value(f, "  Head   office \n")).toBe("Head office");
  });
  it("refuses a blank cell and says a blank is not a zero", () => {
    expect(error(f, "   ")).toContain("never read as zero");
  });
  it("enforces a pattern in the user's words", () => {
    const mpan = textField({ pattern: /^\d{13}$/, patternMessage: "a 13 digit MPAN" });
    expect(value(mpan, "1200012345678")).toBe("1200012345678");
    expect(error(mpan, "12000123")).toContain("a 13 digit MPAN");
  });
  it("upper-cases and length-checks when asked", () => {
    expect(value(textField({ upper: true }), "gb-north")).toBe("GB-NORTH");
    expect(error(textField({ maxLength: 4 }), "Depot 12")).toContain("too long");
  });
});

describe("numberField", () => {
  const f = numberField();
  it("reads plain numbers", () => {
    expect(value(f, "1234")).toBe(1234);
    expect(value(f, "-12.5")).toBe(-12.5);
    expect(value(f, "0")).toBe(0);
    expect(value(f, "1.2e3")).toBe(1200);
  });
  it("reads comma thousands with a dot decimal", () => {
    expect(value(f, "1,234.5")).toBe(1234.5);
    expect(value(f, "18,450")).toBe(18450);
  });
  it("reads space thousands, including the non-breaking space Excel writes", () => {
    expect(value(f, "1 234.5")).toBe(1234.5);
    expect(value(f, "1 234,5")).toBe(1234.5);
    expect(value(f, "1 234 567")).toBe(1234567);
  });
  it("strips currency symbols, trailing units and accounting brackets", () => {
    expect(value(f, "£1,234")).toBe(1234);
    expect(value(f, "18450 kWh")).toBe(18450);
    expect(value(f, "12.5 t CO2e")).toBe(12.5);
    expect(value(f, "45%")).toBe(45);
    expect(value(f, "(1,234)")).toBe(-1234);
  });
  it("refuses text rather than reading it as zero", () => {
    expect(error(f, "N/A")).toContain("is not a number");
    expect(error(f, "-")).toContain("is not a number");
    expect(error(f, "TBC")).toContain("is not a number");
    expect(error(f, "")).toContain("never read as zero");
    expect(error(f, "12 kWh 3")).toContain("more text after the number");
  });
  it("refuses ambiguous separators with an error naming both readings", () => {
    expect(error(f, "1.234,5")).toContain('uses "." for thousands and "," for the decimal point');
    expect(error(f, "1.234.567")).toContain('uses "." for thousands');
    expect(error(f, "1234,567")).toContain("could be 1234567 or 1234.567");
    expect(error(f, "1,23,456")).toContain("ambiguous");
    expect(error(f, "12 34")).toContain("spaces inside the number");
  });
  it("applies bounds", () => {
    expect(error(numberField({ min: 0 }), "-5")).toContain("below the minimum of 0");
    expect(error(numberField({ max: 100 }), "120")).toContain("above the maximum of 100");
  });
});

describe("integerField", () => {
  it("accepts a whole number with separators", () => {
    expect(value(integerField(), "1,234")).toBe(1234);
  });
  it("refuses a fraction", () => {
    expect(error(integerField(), "12.5")).toContain("whole number");
  });
});

describe("dateField", () => {
  const f = dateField();
  it("reads ISO dates, with or without a time", () => {
    expect(value(f, "2024-01-15")).toBe("2024-01-15");
    expect(value(f, "2024-01-15T09:30:00Z")).toBe("2024-01-15");
    expect(value(f, "2024/01/15")).toBe("2024-01-15");
    expect(value(f, "20240115")).toBe("2024-01-15");
  });
  it("reads UK day-first dates", () => {
    expect(value(f, "15/01/2024")).toBe("2024-01-15");
    expect(value(f, "15-01-2024")).toBe("2024-01-15");
    expect(value(f, "15.01.2024")).toBe("2024-01-15");
    expect(value(f, "15/01/24")).toBe("2024-01-15");
    expect(value(f, "5/1/2024")).toBe("2024-01-05");
  });
  it("reads an ambiguous date day first", () => {
    expect(value(f, "03/04/2024")).toBe("2024-04-03");
    expect(value(f, "01/02/2024")).toBe("2024-02-01");
  });
  it("says dates are read day first when a month-first date fails", () => {
    const message = error(f, "03/15/2024");
    expect(message).toContain("day first");
    expect(message).toContain("month-first (US) date");
  });
  it("reads month names", () => {
    expect(value(f, "15 Jan 2024")).toBe("2024-01-15");
    expect(value(f, "15 January 2024")).toBe("2024-01-15");
    expect(value(f, "15-Jan-24")).toBe("2024-01-15");
    expect(value(f, "Jan 15, 2024")).toBe("2024-01-15");
  });
  it("reads Excel date serials", () => {
    expect(value(f, "45306")).toBe("2024-01-15");
    expect(value(f, "44927")).toBe("2023-01-01");
    expect(value(f, "45306.5")).toBe("2024-01-15");
  });
  it("refuses Excel's non-existent 29 February 1900", () => {
    expect(error(f, "60")).toContain("does not exist");
  });
  it("refuses a small number that is a quantity, not a date", () => {
    expect(error(f, "5")).toContain("is a number, not a date");
  });
  it("refuses an impossible calendar date", () => {
    expect(error(f, "31/02/2024")).toContain("29 days");
    expect(error(f, "2023-02-29")).toContain("28 days");
  });
  it("refuses text and says what to write", () => {
    expect(error(f, "last Tuesday")).toContain("YYYY-MM-DD or DD/MM/YYYY");
    expect(error(f, "")).toContain("never read as zero");
  });
  it("applies bounds", () => {
    expect(error(dateField({ min: "2024-01-01" }), "31/12/2023")).toContain("is before 2024-01-01");
    expect(error(dateField({ max: "2024-12-31" }), "01/01/2025")).toContain("is after 2024-12-31");
  });
});

describe("enumField", () => {
  const f = enumField(["Electricity", "Natural gas", "Diesel"], { aliases: { gas: "Natural gas", elec: "Electricity", derv: "Diesel" } });
  it("matches ignoring case, punctuation and spacing", () => {
    expect(value(f, "electricity")).toBe("Electricity");
    expect(value(f, "  natural-gas ")).toBe("Natural gas");
    expect(value(f, "NATURAL GAS")).toBe("Natural gas");
  });
  it("matches aliases clients actually send", () => {
    expect(value(f, "Gas")).toBe("Natural gas");
    expect(value(f, "DERV")).toBe("Diesel");
  });
  it("lists the accepted values when it cannot match", () => {
    expect(error(f, "LPG")).toBe('"LPG" is not one of: Electricity, Natural gas, Diesel');
  });
});

describe("booleanField", () => {
  const f = booleanField();
  it("accepts the spellings a spreadsheet holds", () => {
    for (const yes of ["yes", "YES", "y", "true", "TRUE", "t", "1"]) expect(value(f, yes)).toBe(true);
    for (const no of ["no", "N", "false", "F", "0"]) expect(value(f, no)).toBe(false);
  });
  it("refuses anything else rather than guessing", () => {
    expect(error(f, "maybe")).toContain("accepted: yes, no, true, false, y, n, 1, 0");
    expect(error(f, "")).toContain("never read as zero");
  });
});

describe("registrationField", () => {
  const f = registrationField();
  it("upper-cases and strips spacing", () => {
    expect(value(f, "ab12 cde")).toBe("AB12CDE");
    expect(value(f, " AB-12-CDE ")).toBe("AB12CDE");
    expect(value(f, "A123 BCD")).toBe("A123BCD");
  });
  it("refuses punctuation that is not a plate", () => {
    expect(error(f, "AB12/CDE")).toContain("letters and digits only");
    expect(error(f, "")).toContain("never read as zero");
  });
  it("checks UK formats only when asked", () => {
    expect(value(f, "IMPORT1")).toBe("IMPORT1");
    expect(error(registrationField({ strict: true }), "IMPORT1")).toContain("recognised UK registration format");
    expect(value(registrationField({ strict: true }), "AB12 CDE")).toBe("AB12CDE");
  });
});

describe("templateCsv", () => {
  it("writes the labels, marks required fields and carries the examples", () => {
    const csv = templateCsv({
      fields: [
        { name: "registration", label: "Registration", required: true, example: "AB12 CDE" },
        { name: "date", label: "Journey date", required: true, example: "15/01/2024" },
        { name: "notes", label: "Notes", example: "" },
      ],
    });
    expect(csv).toContain("Registration*,Journey date*,Notes");
    expect(csv).toContain("AB12 CDE,15/01/2024,");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });
});
