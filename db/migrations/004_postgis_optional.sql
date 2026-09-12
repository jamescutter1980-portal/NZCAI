-- Optional spatial upgrade. Numbered last so it runs after every table exists;
-- the runner applies all migrations in filename order on each invocation and
-- every statement here is idempotent.
--
-- Phase 1 only needs bounding-box filtering, which lat/lng handles. Phase 2
-- wants real proximity ("parcels within 2 km of a substation with headroom")
-- and phase 3 wants parcel intersection - both of which want PostGIS.
--
-- This migration is a no-op where the extension is unavailable, so the app
-- runs unchanged on a plain Postgres. Install postgis and re-run db:migrate
-- to add the column later; it is populated from lat/lng, so no re-ingest.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') THEN
    RAISE NOTICE 'PostGIS not available - skipping spatial columns (lat/lng still work).';
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS postgis;

  ALTER TABLE substation ADD COLUMN IF NOT EXISTS geom geography(Point, 4326);
  ALTER TABLE ecr_record ADD COLUMN IF NOT EXISTS geom geography(Point, 4326);

  UPDATE substation
     SET geom = ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
   WHERE geom IS NULL AND lat IS NOT NULL AND lng IS NOT NULL;

  UPDATE ecr_record
     SET geom = ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
   WHERE geom IS NULL AND lat IS NOT NULL AND lng IS NOT NULL;

  CREATE INDEX IF NOT EXISTS substation_geom_idx ON substation USING GIST (geom);
  CREATE INDEX IF NOT EXISTS ecr_geom_idx ON ecr_record USING GIST (geom);

  -- S-01 reference data, where migration 003 has already created the tables.
  IF to_regclass('public.os_uprn') IS NOT NULL THEN
    ALTER TABLE os_uprn ADD COLUMN IF NOT EXISTS geom geography(Point, 4326);
    UPDATE os_uprn SET geom = ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
     WHERE geom IS NULL;
    CREATE INDEX IF NOT EXISTS os_uprn_geom_idx ON os_uprn USING GIST (geom);
  END IF;

  RAISE NOTICE 'PostGIS spatial columns ready.';
END $$;
