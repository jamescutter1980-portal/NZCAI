import type { Db } from "./sqlite";
import type { MeterReading } from "@/lib/integrations/n3rgy/normalise";
import type { Provenance } from "@/lib/provenance";

export interface ReadingKey {
  mpxn: string;
  utility: "electricity" | "gas";
  direction: "import" | "export";
}

export interface TariffPrice {
  mpxn: string;
  utility: "electricity" | "gas";
  intervalStart: string;
  pencePerKwh: number;
  retrievedAt: string;
}

export interface StandingCharge {
  mpxn: string;
  utility: "electricity" | "gas";
  startDate: string;
  pencePerDay: number;
  retrievedAt: string;
}

interface ReadingRow {
  mpxn: string;
  utility: string;
  direction: string;
  interval_start: string;
  interval_end: string;
  value: number;
  unit: string;
  status: string | null;
  source: string;
  dataset: string;
  basis: string;
  licence: string;
  retrieved_at: string;
  consent_ref: string | null;
}

/** Storage for interval readings and tariffs. */
export class ReadingsRepository {
  constructor(private readonly db: Db) {}

  /** Inserts or replaces readings. Returns the number written. */
  upsertReadings(readings: MeterReading[]): number {
    if (readings.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT INTO meter_readings
        (mpxn, utility, direction, interval_start, interval_end, value, unit, status,
         source, dataset, basis, licence, retrieved_at, consent_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mpxn, utility, direction, interval_start) DO UPDATE SET
        interval_end = excluded.interval_end, value = excluded.value, unit = excluded.unit,
        status = excluded.status, source = excluded.source, dataset = excluded.dataset,
        basis = excluded.basis, licence = excluded.licence, retrieved_at = excluded.retrieved_at,
        consent_ref = excluded.consent_ref
    `);
    this.db.exec("BEGIN");
    try {
      for (const r of readings) {
        stmt.run(
          r.mpxn, r.utility, r.direction, r.intervalStart, r.intervalEnd, r.value, r.unit, r.status ?? null,
          r.provenance.source, r.provenance.dataset, r.provenance.basis, r.provenance.licence,
          r.provenance.retrievedAt, r.provenance.consentRef ?? null,
        );
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return readings.length;
  }

  /** Latest stored interval start for a meter, or undefined if nothing stored. */
  latestIntervalStart(key: ReadingKey): string | undefined {
    const row = this.db
      .prepare("SELECT MAX(interval_start) AS latest FROM meter_readings WHERE mpxn = ? AND utility = ? AND direction = ?")
      .get(key.mpxn, key.utility, key.direction) as { latest: string | null } | undefined;
    return row?.latest ?? undefined;
  }

  /** Readings whose interval start lies in [from, to). */
  listReadings(key: ReadingKey, from: string, to: string): MeterReading[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM meter_readings
         WHERE mpxn = ? AND utility = ? AND direction = ? AND interval_start >= ? AND interval_start < ?
         ORDER BY interval_start`,
      )
      .all(key.mpxn, key.utility, key.direction, from, to) as unknown as ReadingRow[];
    return rows.map(rowToReading);
  }

  countReadings(key: ReadingKey): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM meter_readings WHERE mpxn = ? AND utility = ? AND direction = ?")
      .get(key.mpxn, key.utility, key.direction) as { n: number };
    return row.n;
  }

  /** Distinct meters with stored readings and their coverage. */
  listMeters(): { mpxn: string; utility: string; direction: string; first: string; last: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT mpxn, utility, direction, MIN(interval_start) AS first, MAX(interval_start) AS last, COUNT(*) AS count
         FROM meter_readings GROUP BY mpxn, utility, direction ORDER BY mpxn, utility, direction`,
      )
      .all() as unknown as { mpxn: string; utility: string; direction: string; first: string; last: string; count: number }[];
  }

  upsertTariffPrices(prices: TariffPrice[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO tariff_prices (mpxn, utility, interval_start, pence_per_kwh, retrieved_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mpxn, utility, interval_start) DO UPDATE SET pence_per_kwh = excluded.pence_per_kwh, retrieved_at = excluded.retrieved_at
    `);
    this.db.exec("BEGIN");
    try {
      for (const p of prices) stmt.run(p.mpxn, p.utility, p.intervalStart, p.pencePerKwh, p.retrievedAt);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return prices.length;
  }

  upsertStandingCharges(charges: StandingCharge[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO standing_charges (mpxn, utility, start_date, pence_per_day, retrieved_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mpxn, utility, start_date) DO UPDATE SET pence_per_day = excluded.pence_per_day, retrieved_at = excluded.retrieved_at
    `);
    this.db.exec("BEGIN");
    try {
      for (const c of charges) stmt.run(c.mpxn, c.utility, c.startDate, c.pencePerDay, c.retrievedAt);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return charges.length;
  }

  listTariffPrices(key: Omit<ReadingKey, "direction">, from: string, to: string): TariffPrice[] {
    const rows = this.db
      .prepare(
        `SELECT mpxn, utility, interval_start, pence_per_kwh, retrieved_at FROM tariff_prices
         WHERE mpxn = ? AND utility = ? AND interval_start >= ? AND interval_start < ? ORDER BY interval_start`,
      )
      .all(key.mpxn, key.utility, from, to) as unknown as {
      mpxn: string; utility: "electricity" | "gas"; interval_start: string; pence_per_kwh: number; retrieved_at: string;
    }[];
    return rows.map((r) => ({
      mpxn: r.mpxn, utility: r.utility, intervalStart: r.interval_start, pencePerKwh: r.pence_per_kwh, retrievedAt: r.retrieved_at,
    }));
  }

  /** Standing charges in force at any point up to `to`, most recent first. */
  listStandingCharges(key: Omit<ReadingKey, "direction">): StandingCharge[] {
    const rows = this.db
      .prepare(
        `SELECT mpxn, utility, start_date, pence_per_day, retrieved_at FROM standing_charges
         WHERE mpxn = ? AND utility = ? ORDER BY start_date DESC`,
      )
      .all(key.mpxn, key.utility) as unknown as {
      mpxn: string; utility: "electricity" | "gas"; start_date: string; pence_per_day: number; retrieved_at: string;
    }[];
    return rows.map((r) => ({
      mpxn: r.mpxn, utility: r.utility, startDate: r.start_date, pencePerDay: r.pence_per_day, retrievedAt: r.retrieved_at,
    }));
  }
}

function rowToReading(r: ReadingRow): MeterReading {
  const provenance: Provenance = {
    source: r.source,
    dataset: r.dataset,
    basis: r.basis as Provenance["basis"],
    licence: r.licence as Provenance["licence"],
    retrievedAt: r.retrieved_at,
    territory: "GB",
    attribution: r.source === "n3rgy" ? "Energy data from https://data.n3rgy.com, delivered by n3rgy data Ltd." : "",
    consentRef: r.consent_ref ?? undefined,
  };
  return {
    mpxn: r.mpxn,
    utility: r.utility as MeterReading["utility"],
    direction: r.direction as MeterReading["direction"],
    intervalStart: r.interval_start,
    intervalEnd: r.interval_end,
    value: r.value,
    unit: r.unit,
    status: r.status ?? undefined,
    provenance,
  };
}
