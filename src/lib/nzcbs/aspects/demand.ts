import { DEMAND_MANAGEMENT_MAX_RESOLUTION_MINUTES, DEMAND_MANAGEMENT_MIN_GIA_M2 } from "../constants";
import { aspectResult, notApplicable, reported, round } from "../findings";
import type { AspectResult, DemandInput, Finding } from "../types";

/**
 * 5.6 Electricity demand management: top ten demand values, the 50th and the
 * 1st percentile in kW, across the whole ORP, for buildings over 500 m2 GIA
 * with half-hourly or finer data. Reporting only; no limits (5.6.6).
 */

/** Spreadsheet PERCENTILE.INC on a sorted ascending series. */
export function percentileInclusive(sortedAscending: number[], p: number): number | null {
  const n = sortedAscending.length;
  if (n === 0) return null;
  if (n === 1) return sortedAscending[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return sortedAscending[lo] + (sortedAscending[hi] - sortedAscending[lo]) * frac;
}

export interface DemandStatistics {
  topTenKw: number[];
  p50Kw: number | null;
  p1Kw: number | null;
  intervals: number;
}

export function demandStatistics(intervalKwh: number[], resolutionMinutes: number, excludedIntervalKwh?: number[]): DemandStatistics {
  const perHour = 60 / resolutionMinutes;
  const kw = intervalKwh.map((kwh, i) => round((kwh - (excludedIntervalKwh?.[i] ?? 0)) * perHour));
  const sorted = [...kw].sort((a, b) => a - b);
  return {
    topTenKw: [...sorted].reverse().slice(0, 10),
    p50Kw: sorted.length ? round(percentileInclusive(sorted, 0.5)!) : null,
    p1Kw: sorted.length ? round(percentileInclusive(sorted, 0.01)!) : null,
    intervals: kw.length,
  };
}

export function assessDemand(input: DemandInput | undefined): AspectResult {
  const findings: Finding[] = [];
  const warnings: string[] = [];
  if (!input) {
    findings.push(reported({ id: "dm.top_ten", section: "5.6.3", metric: "Top ten recorded demand values", value: null, unit: "kW", reason: "No half-hourly electricity data was supplied for the ORP." }));
    return aspectResult("electricity_demand_management", "5.6", "Electricity demand management", findings, warnings);
  }
  if (input.giaM2 <= DEMAND_MANAGEMENT_MIN_GIA_M2) {
    findings.push(notApplicable({ id: "dm.scope", section: "5.6.1.2", metric: "Electricity demand management assessment", reason: `GIA ${input.giaM2} m2 is not above ${DEMAND_MANAGEMENT_MIN_GIA_M2} m2, so no assessment is required.`, kind: "reporting" }));
    return aspectResult("electricity_demand_management", "5.6", "Electricity demand management", findings, warnings);
  }
  if (input.resolutionMinutes > DEMAND_MANAGEMENT_MAX_RESOLUTION_MINUTES) {
    findings.push(reported({ id: "dm.top_ten", section: "5.6.2", metric: "Top ten recorded demand values", value: null, unit: "kW", reason: `Metering resolution is ${input.resolutionMinutes} minutes; the Table 16 metrics need half-hourly or finer readings. Submit details of the metering limitation (5.6.5).` }));
    return aspectResult("electricity_demand_management", "5.6", "Electricity demand management", findings, warnings);
  }
  const s = demandStatistics(input.intervalKwh, input.resolutionMinutes, input.excludedIntervalKwh);
  const basis = `${s.intervals} readings at ${input.resolutionMinutes}-minute resolution; kW = kWh x ${60 / input.resolutionMinutes}; percentiles by linear interpolation (spreadsheet PERCENTILE.INC) across the whole ORP (5.6.3).`;
  findings.push(reported({ id: "dm.top_ten", section: "5.6.3", metric: "Top ten recorded demand values", value: s.topTenKw[0] ?? null, unit: "kW", reason: `Peak and the next nine: ${s.topTenKw.join(", ")}.`, basis }));
  findings.push(reported({ id: "dm.p50", section: "5.6.3", metric: "50th percentile demand value", value: s.p50Kw, unit: "kW", reason: "Median reading.", basis }));
  findings.push(reported({ id: "dm.p1", section: "5.6.3", metric: "1st percentile demand value", value: s.p1Kw, unit: "kW", reason: "Reading below which the lowest 1% fall.", basis }));
  const expected = Math.round((365 * 24 * 60) / input.resolutionMinutes);
  if (s.intervals < expected * 0.9) warnings.push(`Only ${s.intervals} of about ${expected} expected readings were supplied; gaps must be declared (5.6.5).`);
  return aspectResult("electricity_demand_management", "5.6", "Electricity demand management", findings, warnings);
}
