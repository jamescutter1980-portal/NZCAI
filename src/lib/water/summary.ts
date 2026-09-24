import type { WaterBasis, WaterSource, SupplyPointRecord, ConsumptionRecord } from "./types";

export interface SupplyPointSummary {
  supplyPoint: SupplyPointRecord;
  readingCount: number;
  totalM3: number;
  /** Indicative cost where unit costs were supplied on rows. */
  costGbp: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  bases: WaterBasis[];
  sources: WaterSource[];
}

export interface WaterPortfolioSummary {
  supplyPointCount: number;
  readingCount: number;
  totalM3: number;
  costGbp: number | null;
  byBasis: Record<WaterBasis, number>;
  bySource: Record<WaterSource, number>;
  bySupplyPoint: SupplyPointSummary[];
  from: string | null;
  to: string | null;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function summariseSupplyPoint(sp: SupplyPointRecord, readings: ConsumptionRecord[]): SupplyPointSummary {
  const mine = readings.filter((r) => r.supplyPointId === sp.id);
  let cost = 0;
  let costRows = 0;
  for (const r of mine) {
    if (r.unitCostGbpPerM3 !== undefined) {
      cost += r.volumeM3 * r.unitCostGbpPerM3;
      costRows += 1;
    }
  }
  return {
    supplyPoint: sp,
    readingCount: mine.length,
    totalM3: round3(mine.reduce((n, r) => n + r.volumeM3, 0)),
    costGbp: costRows > 0 ? round3(cost) : null,
    periodStart: mine.length ? mine.map((r) => r.periodStart).sort()[0] : null,
    periodEnd: mine.length ? mine.map((r) => r.periodEnd).sort().at(-1)! : null,
    bases: [...new Set(mine.map((r) => r.basis))],
    sources: [...new Set(mine.map((r) => r.source))],
  };
}

export function summarisePortfolio(
  supplyPoints: SupplyPointRecord[],
  readings: ConsumptionRecord[],
  range: { from?: string; to?: string } = {},
): WaterPortfolioSummary {
  const bySupplyPoint = supplyPoints.map((sp) => summariseSupplyPoint(sp, readings));
  const byBasis: Record<WaterBasis, number> = { measured: 0, estimated: 0, client_declared: 0 };
  const bySource: Record<WaterSource, number> = {
    bill: 0,
    retailer_portal: 0,
    mosl_cmos: 0,
    amr_meter: 0,
    manual: 0,
    benchmark: 0,
  };
  for (const r of readings) {
    byBasis[r.basis] = round3(byBasis[r.basis] + r.volumeM3);
    bySource[r.source] = round3(bySource[r.source] + r.volumeM3);
  }
  const costs = bySupplyPoint.map((s) => s.costGbp).filter((c): c is number => c !== null);
  return {
    supplyPointCount: supplyPoints.length,
    readingCount: readings.length,
    totalM3: round3(bySupplyPoint.reduce((n, s) => n + s.totalM3, 0)),
    costGbp: costs.length ? round3(costs.reduce((n, c) => n + c, 0)) : null,
    byBasis,
    bySource,
    bySupplyPoint,
    from: range.from ?? null,
    to: range.to ?? null,
  };
}
