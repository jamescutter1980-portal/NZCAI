import { fromN3rgyTimestamp } from "./dates";
import type { ChunkedResult } from "./client";
import type { RawTariff } from "./types";

export interface TariffPricePoint {
  /** ISO UTC start of the half hour the price applies to. */
  intervalStart: string;
  pencePerKwh: number;
}

export interface StandingChargePoint {
  startDate: string;
  pencePerDay: number;
}

export interface NormalisedTariff {
  prices: TariffPricePoint[];
  standingCharges: StandingChargePoint[];
  retrievedAt: string;
}

/**
 * Flattens n3rgy tariff responses. n3rgy prices are in pence per kWh and
 * timestamps mark the END of each half hour, like consumption. Standing
 * charges are pence per day from a start date.
 */
export function normaliseTariff(result: ChunkedResult<RawTariff>, opts: { timestampIsIntervalEnd?: boolean } = {}): NormalisedTariff {
  const isEnd = opts.timestampIsIntervalEnd ?? true;
  const prices = new Map<string, number>();
  const charges = new Map<string, number>();
  for (const chunk of result.chunks) {
    for (const v of chunk.values) {
      for (const p of v.prices) {
        const t = new Date(fromN3rgyTimestamp(p.timestamp)).getTime();
        if (Number.isNaN(t)) continue;
        prices.set(new Date(isEnd ? t - 30 * 60_000 : t).toISOString(), p.value);
      }
      for (const s of v.standingCharges) {
        charges.set(fromN3rgyTimestamp(s.startDate).slice(0, 10), s.value);
      }
    }
  }
  return {
    prices: [...prices].map(([intervalStart, pencePerKwh]) => ({ intervalStart, pencePerKwh })).sort((a, b) => a.intervalStart.localeCompare(b.intervalStart)),
    standingCharges: [...charges].map(([startDate, pencePerDay]) => ({ startDate, pencePerDay })).sort((a, b) => a.startDate.localeCompare(b.startDate)),
    retrievedAt: result.retrievedAt,
  };
}
