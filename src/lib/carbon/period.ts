/**
 * Reporting periods. A period is a half-open UTC interval [from, to).
 *
 * `factorYear` is the DESNZ conversion-factor set the period reports against.
 * For a calendar year that is the year itself. For a fiscal year or a rolling
 * twelve months it defaults to the year the period starts, which is the common
 * UK convention (the factor set published for the reporting year), and it is
 * always stated in the output so a reader can check it.
 */
export type PeriodKind = "calendar" | "fiscal" | "rolling12";

export interface Period {
  kind: PeriodKind;
  /** Human label, e.g. "2025", "FY 2025/26 (Apr-Mar)", "12 months to 31 Aug 2026". */
  label: string;
  /** Inclusive ISO instant. */
  from: string;
  /** Exclusive ISO instant. */
  to: string;
  /** Whole days in the period. */
  days: number;
  factorYear: number;
}

const MS_PER_DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function build(kind: PeriodKind, label: string, fromMs: number, toMs: number, factorYear: number): Period {
  return {
    kind,
    label,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    days: Math.round((toMs - fromMs) / MS_PER_DAY),
    factorYear,
  };
}

export function calendarYear(year: number): Period {
  return build("calendar", String(year), Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1), year);
}

/**
 * Fiscal year starting on the first day of `startMonth` (1-12) in `startYear`.
 * The UK financial year convention is April, so fiscalYear(2025, 4) is
 * 1 April 2025 to 31 March 2026.
 */
export function fiscalYear(startYear: number, startMonth: number, factorYear?: number): Period {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new RangeError("startMonth must be 1 to 12");
  }
  const from = Date.UTC(startYear, startMonth - 1, 1);
  const to = Date.UTC(startYear + 1, startMonth - 1, 1);
  const endLabelYear = String(startYear + 1).slice(-2);
  const label =
    startMonth === 1
      ? `FY ${startYear}`
      : `FY ${startYear}/${endLabelYear} (${MONTHS[startMonth - 1]}-${MONTHS[(startMonth + 10) % 12]})`;
  return build("fiscal", label, from, to, factorYear ?? startYear);
}

/** The twelve months ending on `endDate` (YYYY-MM-DD, inclusive). */
export function rollingTwelveMonths(endDate: string, factorYear?: number): Period {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDate);
  if (!m) throw new RangeError("endDate must be YYYY-MM-DD");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const to = Date.UTC(y, mo - 1, d) + MS_PER_DAY;
  const from = Date.UTC(y - 1, mo - 1, d);
  const label = `12 months to ${d} ${MONTHS[mo - 1]} ${y}`;
  return build("rolling12", label, from, to, factorYear ?? new Date(from).getUTCFullYear());
}

export interface PeriodQuery {
  kind?: string;
  year?: number;
  /** Fiscal start month, 1-12. */
  startMonth?: number;
  /** Rolling period end date, YYYY-MM-DD. */
  endDate?: string;
  factorYear?: number;
}

/** Builds a period from query parameters, defaulting to the last complete calendar year. */
export function resolvePeriod(q: PeriodQuery = {}, now = new Date()): Period {
  const kind = (q.kind ?? "calendar") as PeriodKind;
  if (kind === "fiscal") {
    const year = q.year ?? now.getUTCFullYear() - 1;
    return fiscalYear(year, q.startMonth ?? 4, q.factorYear);
  }
  if (kind === "rolling12") {
    const endDate = q.endDate ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - MS_PER_DAY).toISOString().slice(0, 10);
    return rollingTwelveMonths(endDate, q.factorYear);
  }
  if (kind !== "calendar") throw new RangeError(`Unknown period kind "${q.kind}"`);
  const year = q.year ?? now.getUTCFullYear() - 1;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new RangeError("year must be a four-digit year");
  const p = calendarYear(year);
  return q.factorYear ? { ...p, factorYear: q.factorYear } : p;
}

/** Days of the period that have already elapsed, for completeness reporting. */
export function elapsedDays(period: Period, now = new Date()): number {
  const from = Date.parse(period.from);
  const to = Math.min(Date.parse(period.to), now.getTime());
  return Math.max(0, Math.round((to - from) / MS_PER_DAY));
}
