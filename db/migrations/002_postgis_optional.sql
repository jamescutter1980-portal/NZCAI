-- Optional spatial upgrade.
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

  RAISE NOTICE 'PostGIS spatial columns ready.';
END $$;
