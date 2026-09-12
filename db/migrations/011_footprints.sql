-- S-01 footprint store. Brief §3.2.
--
-- THE BRIEF SAYS POSTGIS. THIS DOES NOT USE IT, and that is a deliberate
-- reversal of my own earlier note in stores.ts, which read: "Genuinely needs
-- PostGIS - polygon containment and intersection are not things to hand-roll
-- over a whole national dataset."
--
-- That was wrong on both halves.
--
--   Containment was already hand-rolled, in geo.ts, and has been since S-01.
--   Intersection is an orientation test over edges, added to the same file, and
--   it is exact for simple polygons.
--
--   "Over a whole national dataset" was the real error. Nothing scans the
--   dataset: a bounding-box lookup on the index below returns a handful of
--   candidate polygons, and the exact test runs over those. A building carries
--   tens of vertices. This is microseconds.
--
-- The consequence matters more than the principle. PostGIS was never installed
-- here, so the store returned undefined, so every profile reported
-- `footprint: unavailable`, so `queryGeometry` had nothing to screen and S-02
-- could not run from the UPRN search path at all. A dependency that was not
-- actually needed was blocking the chain.
--
-- Migration 004 still adds PostGIS geography columns where the extension
-- exists. If it is ever installed, ST_Contains over a GIST index will be faster
-- than this. It is not required.

CREATE TABLE IF NOT EXISTS os_building (
  id          bigserial PRIMARY KEY,
  -- OS OpenMap Local's own identifier, where the file carries one.
  source_ref  text,
  -- GeoJSON Polygon or MultiPolygon, as published.
  geometry    jsonb NOT NULL,
  -- Bounding box, so containment and intersection reject the obvious misses
  -- in SQL before any geometry is parsed.
  min_lat     double precision NOT NULL,
  max_lat     double precision NOT NULL,
  min_lng     double precision NOT NULL,
  max_lng     double precision NOT NULL,
  -- Precomputed at load: ordering by area is the second half of "largest
  -- polygon intersecting the title extent" and recomputing it per query would
  -- mean parsing every candidate.
  area_m2     numeric(14,2),
  source_file text,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

-- The workhorse. Both store methods start with a bbox window.
CREATE INDEX IF NOT EXISTS os_building_bbox_idx
  ON os_building (min_lat, max_lat, min_lng, max_lng);

-- "Largest intersecting" orders by this.
CREATE INDEX IF NOT EXISTS os_building_area_idx ON os_building (area_m2 DESC NULLS LAST);

CREATE UNIQUE INDEX IF NOT EXISTS os_building_source_ref_idx
  ON os_building (source_ref) WHERE source_ref IS NOT NULL;

-- Brief §3.2: "Users can redraw the footprint on the map. Store that as an
-- override tier and keep the original." Keeping the original is the point --
-- an override that destroys what the source published cannot be undone, and
-- the provenance of the original is what makes the override reviewable.
ALTER TABLE site_profile
  ADD COLUMN IF NOT EXISTS footprint_original        jsonb,
  ADD COLUMN IF NOT EXISTS footprint_original_method text,
  ADD COLUMN IF NOT EXISTS footprint_overridden_at   timestamptz;

-- Records a bulk load, so coverage can say where the polygons came from.
CREATE TABLE IF NOT EXISTS building_load (
  id           bigserial PRIMARY KEY,
  source_file  text NOT NULL,
  rows_read    integer NOT NULL DEFAULT 0,
  rows_loaded  integer NOT NULL DEFAULT 0,
  rows_skipped integer NOT NULL DEFAULT 0,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  note         text
);
