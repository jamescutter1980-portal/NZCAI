import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Portal database. SQLite through Node's built-in driver, so no native build
 * step. Path from DB_PATH, default data/portal.sqlite; ":memory:" for tests.
 *
 * Schema changes go in MIGRATIONS as append-only steps; each runs once.
 */
const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "0001_consents",
    sql: `
      CREATE TABLE consents (
        id TEXT PRIMARY KEY,
        mpxn TEXT NOT NULL,
        utilities TEXT NOT NULL,
        asset_ref TEXT,
        site_address TEXT,
        occupier_name TEXT NOT NULL,
        occupier_email TEXT,
        occupier_organisation TEXT,
        method TEXT NOT NULL,
        evidence_ref TEXT,
        granted_on TEXT NOT NULL,
        expires_on TEXT NOT NULL,
        status TEXT NOT NULL,
        notes TEXT,
        recorded_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        withdrawn_at TEXT,
        withdrawn_reason TEXT,
        last_verified_at TEXT,
        last_verification_result TEXT,
        last_verification_detail TEXT
      );
      CREATE INDEX consents_mpxn ON consents(mpxn);
    `,
  },
  {
    id: "0002_meter_readings",
    sql: `
      CREATE TABLE meter_readings (
        mpxn TEXT NOT NULL,
        utility TEXT NOT NULL,
        direction TEXT NOT NULL,
        interval_start TEXT NOT NULL,
        interval_end TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT NOT NULL,
        status TEXT,
        source TEXT NOT NULL,
        dataset TEXT NOT NULL,
        basis TEXT NOT NULL,
        licence TEXT NOT NULL,
        retrieved_at TEXT NOT NULL,
        consent_ref TEXT,
        PRIMARY KEY (mpxn, utility, direction, interval_start)
      );
    `,
  },
  {
    id: "0003_tariffs",
    sql: `
      CREATE TABLE tariff_prices (
        mpxn TEXT NOT NULL,
        utility TEXT NOT NULL,
        interval_start TEXT NOT NULL,
        pence_per_kwh REAL NOT NULL,
        retrieved_at TEXT NOT NULL,
        PRIMARY KEY (mpxn, utility, interval_start)
      );
      CREATE TABLE standing_charges (
        mpxn TEXT NOT NULL,
        utility TEXT NOT NULL,
        start_date TEXT NOT NULL,
        pence_per_day REAL NOT NULL,
        retrieved_at TEXT NOT NULL,
        PRIMARY KEY (mpxn, utility, start_date)
      );
    `,
  },
  {
    id: "0004_sync_runs",
    sql: `
      CREATE TABLE sync_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        trigger TEXT NOT NULL,
        environment TEXT NOT NULL,
        summary TEXT
      );
      CREATE TABLE sync_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES sync_runs(id),
        consent_id TEXT NOT NULL,
        mpxn TEXT NOT NULL,
        utility TEXT NOT NULL,
        direction TEXT NOT NULL,
        from_ts TEXT,
        to_ts TEXT,
        readings_upserted INTEGER NOT NULL DEFAULT 0,
        tariff_rows INTEGER NOT NULL DEFAULT 0,
        gaps TEXT,
        warning TEXT,
        error TEXT
      );
      CREATE INDEX sync_items_run ON sync_items(run_id);
    `,
  },
];

export type Db = DatabaseSync;

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: Db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

let singleton: Db | undefined;

export function getDb(): Db {
  if (!singleton) singleton = openDatabase(process.env.DB_PATH?.trim() || "data/portal.sqlite");
  return singleton;
}

/** Test hook. */
export function setDb(db: Db | undefined) {
  singleton = db;
}
