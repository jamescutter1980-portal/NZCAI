import { fromN3rgyTimestamp } from "./dates";
import type { Provenance } from "@/lib/provenance";
import type { ChunkedResult, ConsumptionQuery } from "./client";
import type { RawConsumption } from "./types";

export const N3RGY_ATTRIBUTION = "Energy data from https://data.n3rgy.com, delivered by n3rgy data Ltd.";

export interface MeterReading {
  mpxn: string;
  utility: "electricity" | "gas";
  /** "import" for consumption, "export" for production. */
  direction: "import" | "export";
  /** ISO 8601 UTC start and end of the interval. */
  intervalStart: string;
  intervalEnd: string;
  value: number;
  unit: string;
  /** Status flag as returned by n3rgy, if any (for example estimated reads). */
  status?: string;
  provenance: Provenance;
}

export interface NormaliseOptions {
  /**
   * n3rgy timestamps mark the END of each half hour. Set to false only if a
   * live run shows the platform returning interval starts.
   */
  timestampIsIntervalEnd?: boolean;
  consentRef?: string;
  direction?: "import" | "export";
}

const INTERVAL_MS: Record<string, number> = { halfhour: 30 * 60_000, daily: 24 * 60 * 60_000 };

/** Flattens chunked raw responses into portal meter readings with provenance. */
export function normaliseConsumption(
  q: Pick<ConsumptionQuery, "mpxn" | "utility">,
  result: ChunkedResult<RawConsumption>,
  opts: NormaliseOptions = {},
): MeterReading[] {
  const isEnd = opts.timestampIsIntervalEnd ?? true;
  const direction = opts.direction ?? "import";
  const readings: MeterReading[] = [];
  const seen = new Set<string>();

  for (const chunk of result.chunks) {
    const intervalMs = INTERVAL_MS[chunk.granularity] ?? INTERVAL_MS.halfhour;
    const provenance: Provenance = {
      source: "n3rgy",
      dataset: `${q.utility}/${direction === "import" ? "consumption" : "production"}/${chunk.granularity}`,
      retrievedAt: result.retrievedAt,
      territory: "GB",
      licence: "consent_based",
      attribution: N3RGY_ATTRIBUTION,
      basis: "measured",
      consentRef: opts.consentRef,
    };
    for (const v of chunk.values) {
      const stamp = new Date(fromN3rgyTimestamp(v.timestamp)).getTime();
      if (Number.isNaN(stamp)) continue;
      const intervalStart = new Date(isEnd ? stamp - intervalMs : stamp).toISOString();
      const intervalEnd = new Date(isEnd ? stamp : stamp + intervalMs).toISOString();
      if (seen.has(intervalStart)) continue;
      seen.add(intervalStart);
      readings.push({
        mpxn: q.mpxn,
        utility: q.utility,
        direction,
        intervalStart,
        intervalEnd,
        value: v.value,
        unit: chunk.unit,
        status: v.status,
        provenance,
      });
    }
  }
  readings.sort((a, b) => a.intervalStart.localeCompare(b.intervalStart));
  return readings;
}

export interface DailyTotal {
  date: string;
  value: number;
  unit: string;
  intervals: number;
}

/** Sums readings by UTC calendar day of interval start. */
export function dailyTotals(readings: MeterReading[]): DailyTotal[] {
  const map = new Map<string, DailyTotal>();
  for (const r of readings) {
    const date = r.intervalStart.slice(0, 10);
    const cur = map.get(date) ?? { date, value: 0, unit: r.unit, intervals: 0 };
    cur.value += r.value;
    cur.intervals += 1;
    map.set(date, cur);
  }
  return [...map.values()]
    .map((d) => ({ ...d, value: Math.round(d.value * 1000) / 1000 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function readingsToCsv(readings: MeterReading[]): string {
  const header = "mpxn,utility,direction,interval_start,interval_end,value,unit,status,source,basis,retrieved_at";
  const rows = readings.map((r) =>
    [
      r.mpxn,
      r.utility,
      r.direction,
      r.intervalStart,
      r.intervalEnd,
      r.value,
      r.unit,
      r.status ?? "",
      r.provenance.source,
      r.provenance.basis,
      r.provenance.retrievedAt,
    ].join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}
