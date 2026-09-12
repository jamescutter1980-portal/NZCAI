-- S-03 completion: brief §5.1 (which DNO), §5.3 (normalised schema).
--
-- §5.1 WHICH DNO. Until now the DNO came from whichever substation happened to
-- be nearest, which is not the same question: licence areas are administrative
-- boundaries and the nearest substation can easily sit across one. The brief
-- says point-in-polygon against the NESO "GIS Boundaries for GB DNO Licence
-- Areas", so the polygons are stored and the answer comes from containment.
--
-- Geometry is jsonb, not PostGIS. PostGIS stays optional in this build (see
-- 004), and there are ~14 licence areas — a ray-cast in TypeScript over that
-- is microseconds and keeps the app deployable on plain Postgres.

CREATE TABLE IF NOT EXISTS dno_licence_area (
  id           bigserial PRIMARY KEY,
  dno_id       text REFERENCES dno(id) ON DELETE SET NULL,
  -- The name as NESO publishes it, kept even when it maps to no known dno row,
  -- so an unmatched area is visible rather than dropped.
  area_name    text NOT NULL,
  licence_ref  text,
  geometry     jsonb NOT NULL,
  -- Bounding box, so containment tests reject the obvious misses first.
  min_lat      double precision NOT NULL,
  max_lat      double precision NOT NULL,
  min_lng      double precision NOT NULL,
  max_lng      double precision NOT NULL,
  -- The brief asks for the version date to be stored, because a boundary that
  -- moved is a different answer to "which DNO".
  version_date date,
  source_ref   text NOT NULL,
  ingested_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (area_name, source_ref)
);

CREATE INDEX IF NOT EXISTS dno_licence_area_bbox_idx
  ON dno_licence_area (min_lat, max_lat, min_lng, max_lng);

-- §5.3 Substation: level, the published source date, and the supply-area
-- polygon where a DNO publishes one.
ALTER TABLE substation
  -- GSP | BSP | primary | secondary. Nullable: not every portal states it.
  ADD COLUMN IF NOT EXISTS level        text
    CHECK (level IS NULL OR level IN ('GSP','BSP','primary','secondary')),
  -- Whether the level came from the source or was inferred from voltage. An
  -- inference must never be presented as a published classification.
  ADD COLUMN IF NOT EXISTS level_source text NOT NULL DEFAULT 'unknown'
    CHECK (level_source IN ('stated','derived_from_voltage','unknown')),
  -- When the DNO says the data was published. Distinct from ingested_at, which
  -- is when we fetched it; the brief's staleness rule is about the former.
  ADD COLUMN IF NOT EXISTS source_date  date,
  -- The DNO's own supply-area polygon, where published (§5.4 step 1).
  ADD COLUMN IF NOT EXISTS area_geom    jsonb;

CREATE INDEX IF NOT EXISTS substation_level_idx ON substation (level);

-- §5.3 EcrEntry: the brief's vocabulary is technology + status, which is not
-- what the portals publish. The raw columns stay; these carry the normalised
-- values so a mapping that failed is visible as 'unknown' rather than guessed.
ALTER TABLE ecr_record
  ADD COLUMN IF NOT EXISTS technology  text,
  ADD COLUMN IF NOT EXISTS status      text NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('connected','accepted','unknown')),
  ADD COLUMN IF NOT EXISTS source_date date;

CREATE INDEX IF NOT EXISTS ecr_technology_idx ON ecr_record (technology);
CREATE INDEX IF NOT EXISTS ecr_status_idx ON ecr_record (status);
