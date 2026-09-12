import { describe, expect, it } from "vitest";
import { calendarYear, elapsedDays, fiscalYear, resolvePeriod, rollingTwelveMonths } from "../period";
import { periodFromSearchParams } from "../period-params";

describe("periods", () => {
  it("builds a calendar year as a half-open UTC interval", () => {
    expect(calendarYear(2025)).toMatchObject({ kind: "calendar", label: "2025", from: "2025-01-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z", days: 365, factorYear: 2025 });
    expect(calendarYear(2024).days).toBe(366);
  });

  it("builds a UK fiscal year and labels it", () => {
    const p = fiscalYear(2025, 4);
    expect(p).toMatchObject({ kind: "fiscal", from: "2025-04-01T00:00:00.000Z", to: "2026-04-01T00:00:00.000Z", factorYear: 2025 });
    expect(p.label).toBe("FY 2025/26 (Apr-Mar)");
    expect(fiscalYear(2025, 1).label).toBe("FY 2025");
    expect(() => fiscalYear(2025, 13)).toThrow(RangeError);
  });

  it("builds a rolling twelve months inclusive of the end date", () => {
    const p = rollingTwelveMonths("2026-08-31");
    expect(p).toMatchObject({ kind: "rolling12", from: "2025-08-31T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z", factorYear: 2025 });
    expect(p.label).toBe("12 months to 31 Aug 2026");
    expect(() => rollingTwelveMonths("nope")).toThrow(RangeError);
  });

  it("lets the factor year be overridden", () => {
    expect(fiscalYear(2025, 4, 2026).factorYear).toBe(2026);
    expect(resolvePeriod({ kind: "calendar", year: 2025, factorYear: 2026 }).factorYear).toBe(2026);
  });

  it("defaults to the last complete calendar year", () => {
    expect(resolvePeriod({}, new Date("2026-09-10T00:00:00Z")).label).toBe("2025");
    expect(resolvePeriod({ kind: "rolling12" }, new Date("2026-09-10T00:00:00Z")).label).toBe("12 months to 31 Aug 2026");
    expect(() => resolvePeriod({ kind: "quarter" })).toThrow(RangeError);
  });

  it("counts only elapsed days for a period still running", () => {
    const p = calendarYear(2026);
    expect(elapsedDays(p, new Date("2026-01-11T00:00:00Z"))).toBe(10);
    expect(elapsedDays(p, new Date("2027-06-01T00:00:00Z"))).toBe(365);
    expect(elapsedDays(p, new Date("2020-01-01T00:00:00Z"))).toBe(0);
  });

  it("parses period query parameters and rejects bad ones", () => {
    const ok = periodFromSearchParams("https://x/api?kind=fiscal&year=2025&startMonth=4");
    expect(ok.ok && ok.period.label).toBe("FY 2025/26 (Apr-Mar)");
    const bad = periodFromSearchParams("https://x/api?kind=quarter");
    expect(bad.ok).toBe(false);
    const badYear = periodFromSearchParams("https://x/api?year=1066");
    expect(badYear.ok).toBe(false);
  });
});
