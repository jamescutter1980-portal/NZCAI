-- NZC AI :: land module, phase 1
-- Grid capacity screening. Sources: the LTDS Capacity Heatmap (standardised
-- under Ofgem's LTDS direction, first published 29 May 2026) and the
-- Embedded Capacity Register.
--
-- Coordinates are held as plain lat/lng so this runs on any Postgres. The
-- PostGIS geography column is added by 002 where the extension exists; it is
-- an optimisation for phase 2 proximity work, not a requirement here.

CREATE TABLE IF NOT EXISTS dno (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  portal_host text NOT NULL
);

-- One row per substation per DNO.
-- Headroom is MVA: this is NETWORK capacity. It is not a site's agreed supply
-- capacity (kVA, per-MPAN, commercially held), which arrives in phase 3.
CREATE TABLE IF NOT EXISTS substation (
  id                      bigserial PRIMARY KEY,
  dno_id                  text NOT NULL REFERENCES dno(id) ON DELETE CASCADE,
  source_ref              text NOT NULL,
  name                    text,
  voltage_kv              numeric(8,3),
  voltage_group           text,
  lat                     double precision,
  lng                     double precision,
  demand_headroom_mva     numeric(12,3),
  generation_headroom_mva numeric(12,3),
  demand_rag              text CHECK (demand_rag IN ('green','amber','red')),
  generation_rag          text CHECK (generation_rag IN ('green','amber','red')),
  constraint_note         text,
  source_dataset          text NOT NULL,
  ingested_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dno_id, source_ref),
  CONSTRAINT substation_lat_range CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90)),
  CONSTRAINT substation_lng_range CHECK (lng IS NULL OR (lng BETWEEN -180 AND 180))
);

-- Viewport queries filter on both axes, so index the pair.
CREATE INDEX IF NOT EXISTS substation_latlng_idx ON substation (lat, lng);
CREATE INDEX IF NOT EXISTS substation_gen_headroom_idx
  ON substation (generation_headroom_mva DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS substation_voltage_idx ON substation (voltage_kv);

-- Embedded Capacity Register: what is already connected or accepted.
-- Republished monthly by every DNO and IDNO within 10 working days of month end.
CREATE TABLE IF NOT EXISTS ecr_record (
  id                     bigserial PRIMARY KEY,
  dno_id                 text NOT NULL REFERENCES dno(id) ON DELETE CASCADE,
  source_ref             text,
  site_name              text,
  connection_voltage_kv  numeric(8,3),
  import_capacity_mva    numeric(12,3),
  export_capacity_mva    numeric(12,3),
  energy_source          text,
  connection_status      text,
  substation_name        text,
  lat                    double precision,
  lng                    double precision,
  source_dataset         text NOT NULL,
  ingested_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ecr_latlng_idx ON ecr_record (lat, lng);
CREATE INDEX IF NOT EXISTS ecr_source_idx ON ecr_record (energy_source);

-- Audit trail. Every run is recorded whether it succeeds or not, so a layer
-- that has silently gone stale is visible rather than assumed fresh.
CREATE TABLE IF NOT EXISTS ingest_run (
  id           bigserial PRIMARY KEY,
  dno_id       text NOT NULL,
  dataset      text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('heatmap','ecr')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  rows_read    integer NOT NULL DEFAULT 0,
  rows_written integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','ok','failed')),
  message      text
);

CREATE INDEX IF NOT EXISTS ingest_run_recent_idx
  ON ingest_run (dno_id, kind, started_at DESC);
