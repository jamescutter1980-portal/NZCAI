import type { Db } from "@/lib/db/sqlite";
import type { OperationContext } from "@/lib/integrations/framework";
import { halfHourlyIntensitySeries, outwardCode } from "@/lib/integrations/carbon-intensity";

/** Region key used in grid_intensity: the postcode outward code. */
export function gridRegionKey(postcode: string): string {
  return outwardCode(postcode).toUpperCase();
}

/**
 * Backfills half-hourly regional grid intensity for a postcode between two
 * dates (inclusive UTC days), 31 days per upstream batch. Idempotent.
 */
export async function syncGridIntensity(db: Db, ctx: OperationContext, postcode: string, from: string, to: string): Promise<{ region: string; rows: number; batches: number }> {
  const region = gridRegionKey(postcode);
  const stmt = db.prepare(
    `INSERT INTO grid_intensity (region, interval_start, gco2_per_kwh, basis, retrieved_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(region, interval_start) DO UPDATE SET gco2_per_kwh = excluded.gco2_per_kwh, basis = excluded.basis, retrieved_at = excluded.retrieved_at`,
  );
  let rows = 0;
  let batches = 0;
  for (const chunk of chunkDays(from, to, 31)) {
    const series = await halfHourlyIntensitySeries(ctx, chunk.from, chunk.to, postcode);
    batches += 1;
    const retrievedAt = ctx.now().toISOString();
    db.exec("BEGIN");
    try {
      for (const p of series) {
        stmt.run(region, new Date(p.from).toISOString(), p.gco2_per_kwh, p.basis, retrievedAt);
        rows += 1;
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return { region, rows, batches };
}

export function intensityCoverage(db: Db, region: string, year: number): { intervals: number; first?: string; last?: string } {
  const r = db
    .prepare("SELECT COUNT(*) AS n, MIN(interval_start) AS first, MAX(interval_start) AS last FROM grid_intensity WHERE region = ? AND interval_start >= ? AND interval_start < ?")
    .get(region, `${year}-01-01T00:00:00.000Z`, `${year + 1}-01-01T00:00:00.000Z`) as { n: number; first: string | null; last: string | null };
  return { intervals: r.n, first: r.first ?? undefined, last: r.last ?? undefined };
}

function chunkDays(from: string, to: string, maxDays: number): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (start <= end) {
    const chunkEnd = new Date(Math.min(start.getTime() + (maxDays - 1) * 86_400_000, end.getTime()));
    out.push({ from: start.toISOString().slice(0, 10), to: chunkEnd.toISOString().slice(0, 10) });
    start = new Date(chunkEnd.getTime() + 86_400_000);
  }
  return out;
}
