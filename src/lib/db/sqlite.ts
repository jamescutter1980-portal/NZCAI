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
  {
    id: "0005_assets",
    sql: `
      CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        uprn TEXT,
        address TEXT,
        postcode TEXT,
        latitude REAL,
        longitude REAL,
        floor_area_m2 REAL,
        property_type TEXT,
        country TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE asset_meters (
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        mpxn TEXT NOT NULL,
        utility TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'import',
        label TEXT,
        supplier_factor_kgco2e_per_kwh REAL,
        supplier_factor_evidence TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (asset_id, mpxn, utility, direction)
      );
      CREATE TABLE asset_screenings (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        ran_at TEXT NOT NULL,
        results TEXT NOT NULL,
        ok_count INTEGER NOT NULL,
        error_count INTEGER NOT NULL
      );
      CREATE INDEX asset_screenings_asset ON asset_screenings(asset_id, ran_at);
      CREATE TABLE grid_intensity (
        region TEXT NOT NULL,
        interval_start TEXT NOT NULL,
        gco2_per_kwh REAL,
        basis TEXT NOT NULL,
        retrieved_at TEXT NOT NULL,
        PRIMARY KEY (region, interval_start)
      );
    `,
  },
  {
    id: "0007_meter_allocation",
    sql: `ALTER TABLE asset_meters ADD COLUMN share REAL NOT NULL DEFAULT 1.0;`,
  },
  {
    id: "0008_transport",
    sql: `
      CREATE TABLE vehicles (
        id TEXT PRIMARY KEY,
        registration TEXT,
        make TEXT,
        model TEXT,
        fuel_type TEXT,
        engine_capacity_cc INTEGER,
        co2_g_per_km REAL,
        year_of_manufacture INTEGER,
        ownership TEXT NOT NULL,
        enrichment_source TEXT,
        enriched_at TEXT,
        enrichment_detail TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX vehicles_registration ON vehicles(registration);
      CREATE TABLE transport_activity (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        label TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
        vehicle_id TEXT REFERENCES vehicles(id) ON DELETE SET NULL,
        quantity REAL NOT NULL,
        unit TEXT NOT NULL,
        factor_id TEXT,
        factor_year INTEGER,
        basis TEXT NOT NULL,
        evidence TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX transport_activity_period ON transport_activity(period_start);
    `,
  },
  {
    id: "0009_site_activity",
    sql: `
      CREATE TABLE site_activity (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        label TEXT NOT NULL,
        asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        quantity REAL NOT NULL,
        unit TEXT NOT NULL,
        refrigerant_type TEXT,
        waste_material TEXT,
        factor_id TEXT,
        factor_year INTEGER,
        basis TEXT NOT NULL,
        evidence TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX site_activity_period ON site_activity(period_start);
      CREATE INDEX site_activity_asset ON site_activity(asset_id);
    `,
  },
  {
    id: "0010_value_chain",
    sql: `
      CREATE TABLE counterparties (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        company_number TEXT,
        sector TEXT,
        country TEXT,
        roles TEXT NOT NULL,
        ghg_categories TEXT NOT NULL,
        annual_value_gbp REAL,
        contact_name TEXT,
        contact_email TEXT,
        escalation_name TEXT,
        escalation_email TEXT,
        ask TEXT NOT NULL,
        status TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX counterparties_name ON counterparties(name);
      CREATE TABLE counterparty_engagements (
        id TEXT PRIMARY KEY,
        counterparty_id TEXT NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
        reporting_year INTEGER NOT NULL,
        state TEXT NOT NULL,
        ask TEXT NOT NULL,
        due_on TEXT,
        last_contact_on TEXT,
        reminders_sent INTEGER NOT NULL DEFAULT 0,
        escalated INTEGER NOT NULL DEFAULT 0,
        decline_reason TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (counterparty_id, reporting_year)
      );
      CREATE TABLE counterparty_engagement_events (
        id TEXT PRIMARY KEY,
        engagement_id TEXT NOT NULL REFERENCES counterparty_engagements(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        channel TEXT,
        detail TEXT,
        actor TEXT
      );
      CREATE INDEX counterparty_engagement_events_engagement ON counterparty_engagement_events(engagement_id, at);
      CREATE TABLE counterparty_emissions (
        id TEXT PRIMARY KEY,
        counterparty_id TEXT NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
        reporting_year INTEGER NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        scope1_tco2e REAL,
        scope2_location_tco2e REAL,
        scope2_market_tco2e REAL,
        scope3_tco2e REAL,
        allocation_method TEXT NOT NULL,
        allocated_tco2e REAL,
        supplier_revenue_gbp REAL,
        methodology TEXT NOT NULL,
        boundary TEXT NOT NULL,
        assurance TEXT NOT NULL,
        assurance_provider TEXT,
        basis TEXT NOT NULL,
        evidence TEXT,
        document_date TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX counterparty_emissions_year ON counterparty_emissions(counterparty_id, reporting_year);
      CREATE TABLE counterparty_activity (
        id TEXT PRIMARY KEY,
        counterparty_id TEXT NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
        reporting_year INTEGER NOT NULL,
        label TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        quantity REAL NOT NULL,
        unit TEXT NOT NULL,
        factor_id TEXT,
        factor_year INTEGER,
        declared_kgco2e REAL,
        share_pct REAL NOT NULL DEFAULT 100,
        basis TEXT NOT NULL,
        evidence TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX counterparty_activity_year ON counterparty_activity(counterparty_id, reporting_year);
    `,
  },
  {
    id: "0011_value_chain_spend_factor",
    sql: `
      ALTER TABLE counterparties ADD COLUMN spend_factor_kgco2e_per_gbp REAL;
      ALTER TABLE counterparties ADD COLUMN spend_factor_source TEXT;
    `,
  },
  {
    id: "0012_value_chain_inbox",
    sql: `
      CREATE TABLE inbound_requests (
        id TEXT PRIMARY KEY,
        counterparty_id TEXT NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        reporting_year INTEGER NOT NULL,
        period_start_month INTEGER NOT NULL DEFAULT 1,
        template TEXT,
        fields TEXT NOT NULL,
        due_on TEXT,
        owner TEXT,
        cadence TEXT NOT NULL,
        state TEXT NOT NULL,
        submitted_on TEXT,
        submitted_figures TEXT,
        submission_note TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX inbound_requests_year ON inbound_requests(reporting_year, due_on);
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
