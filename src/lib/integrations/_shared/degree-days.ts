/**
 * Heating and cooling degree days from daily mean temperatures.
 *
 * Portal logic, not a provider. UK convention: heating degree days (HDD) to a
 * base of 15.5 °C, cooling degree days (CDD) to a base of 22 °C. Both bases are
 * parameters. The calculation is the simple daily-mean method: for each day,
 * HDD = max(0, base - mean) and CDD = max(0, mean - base). This differs from the
 * Met Office / CIBSE max-min method, which uses the daily maximum and minimum
 * with a set of case rules; results are close but not identical, so say which
 * method produced a figure when comparing with published degree-day tables.
 */

export const UK_HDD_BASE_C = 15.5;
export const UK_CDD_BASE_C = 22;

export interface DegreeDayOptions {
  /** Heating base temperature in °C. Default 15.5. */
  hddBase?: number;
  /** Cooling base temperature in °C. Default 22. */
  cddBase?: number;
}

export interface DegreeDayTotals {
  hddBase: number;
  cddBase: number;
  /** Sum of daily HDD over days with a valid mean. */
  hdd: number;
  /** Sum of daily CDD over days with a valid mean. */
  cdd: number;
  /** Days with a valid mean temperature. */
  days: number;
  /** Days skipped because the mean was null, undefined or not finite. */
  missing: number;
  /** Mean of the daily means over valid days, or null when there are none. */
  meanTemperature: number | null;
}

export interface DegreeDayDaily {
  hdd: number | null;
  cdd: number | null;
}

/** Heating degree days for one day from its mean temperature. */
export function heatingDegreeDays(meanC: number, base = UK_HDD_BASE_C): number {
  return Math.max(0, base - meanC);
}

/** Cooling degree days for one day from its mean temperature. */
export function coolingDegreeDays(meanC: number, base = UK_CDD_BASE_C): number {
  return Math.max(0, meanC - base);
}

function isValid(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Per-day HDD and CDD, preserving nulls for missing days. */
export function dailyDegreeDays(means: (number | null | undefined)[], opts: DegreeDayOptions = {}): DegreeDayDaily[] {
  const hddBase = opts.hddBase ?? UK_HDD_BASE_C;
  const cddBase = opts.cddBase ?? UK_CDD_BASE_C;
  return means.map((m) => (isValid(m) ? { hdd: heatingDegreeDays(m, hddBase), cdd: coolingDegreeDays(m, cddBase) } : { hdd: null, cdd: null }));
}

/** Totals over a series of daily mean temperatures. */
export function degreeDayTotals(means: (number | null | undefined)[], opts: DegreeDayOptions = {}): DegreeDayTotals {
  const hddBase = opts.hddBase ?? UK_HDD_BASE_C;
  const cddBase = opts.cddBase ?? UK_CDD_BASE_C;
  let hdd = 0;
  let cdd = 0;
  let days = 0;
  let missing = 0;
  let sum = 0;
  for (const m of means) {
    if (!isValid(m)) {
      missing += 1;
      continue;
    }
    days += 1;
    sum += m;
    hdd += heatingDegreeDays(m, hddBase);
    cdd += coolingDegreeDays(m, cddBase);
  }
  return { hddBase, cddBase, hdd, cdd, days, missing, meanTemperature: days ? sum / days : null };
}

/** Daily mean from a max and min when a mean is not published. */
export function meanFromMaxMin(maxC: number | null | undefined, minC: number | null | undefined): number | null {
  return isValid(maxC) && isValid(minC) ? (maxC + minC) / 2 : null;
}
