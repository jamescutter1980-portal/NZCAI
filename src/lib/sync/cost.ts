import type { MeterReading } from "@/lib/integrations/n3rgy";
import type { StandingCharge, TariffPrice } from "@/lib/db/readings-repo";

export interface CostEstimate {
  /** Energy cost from stored half-hourly prices, pounds. */
  unitCostGbp: number;
  /** Standing charge over the days covered, pounds. */
  standingCostGbp: number;
  totalGbp: number;
  /** Intervals that had no matching price and were excluded. */
  unpricedIntervals: number;
  days: number;
}

/**
 * Estimates cost for import readings from stored tariff data. Purely
 * indicative: prices are as reported by the supplier to n3rgy, exclude VAT
 * and any contract terms the portal does not know about.
 */
export function estimateCost(readings: MeterReading[], prices: TariffPrice[], charges: StandingCharge[]): CostEstimate {
  const priceMap = new Map(prices.map((p) => [p.intervalStart, p.pencePerKwh]));
  let unitPence = 0;
  let unpriced = 0;
  const days = new Set<string>();
  for (const r of readings) {
    days.add(r.intervalStart.slice(0, 10));
    const p = priceMap.get(r.intervalStart);
    if (p === undefined) unpriced += 1;
    else unitPence += r.value * p;
  }
  const sorted = [...charges].sort((a, b) => a.startDate.localeCompare(b.startDate));
  let standingPence = 0;
  for (const d of days) {
    const inForce = sorted.filter((c) => c.startDate <= d).pop();
    if (inForce) standingPence += inForce.pencePerDay;
  }
  return {
    unitCostGbp: round(unitPence / 100),
    standingCostGbp: round(standingPence / 100),
    totalGbp: round((unitPence + standingPence) / 100),
    unpricedIntervals: unpriced,
    days: days.size,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
