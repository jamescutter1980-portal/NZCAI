-- Site Intelligence (S-01): resolve a building from an address.
--
-- os_uprn and postcode_centroid are bulk OS reference data, loaded by
-- `npm run site:ingest`. OS Open UPRN is ~40M rows nationally, so the table is
-- sized and indexed for that even though a first load may be a subset.
--
-- site_profile stores the resolved answer; site_profile_source is its lineage,
-- one row per contributing source, because the brief requires every field to
-- be traceable to a dataset, licence and tier.

CREATE TABLE IF NOT EXISTS os_uprn (
  uprn      text PRIMARY KEY,
  lat       double precision NOT NULL,
  lng       double precision NOT NULL,
  postcode  text,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT os_uprn_lat_range CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT os_uprn_lng_range CHECK (lng BETWEEN -180 AND 180)
);

-- Bounding-box prefilter for "nearest UPRN within 25 m"; the exact great-circle
-- filter runs in application code.
CREATE INDEX IF NOT EXISTS os_uprn_latlng_idx ON os_uprn (lat, lng);
CREATE INDEX IF NOT EXISTS os_uprn_postcode_idx ON os_uprn (postcode);

CREATE TABLE IF NOT EXISTS postcode_centroid (
  postcode   text PRIMARY KEY,
  lat        double precision NOT NULL,
  lng        double precision NOT NULL,
  country    text,
  loaded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_profile (
  id                bigserial PRIMARY KEY,
  building_id       text UNIQUE,
  uprn              text,
  lat               double precision,
  lng               double precision,
  postcode          text,
  country           text,
  lpa_code          text,
  lpa_name          text,
  title_extents     jsonb NOT NULL DEFAULT '[]'::jsonb,
  footprint         jsonb,
  footprint_method  text,
  footprint_area_m2 numeric(14,2),
  match_confidence  text NOT NULL
                      CHECK (match_confidence IN ('exact','probable','approximate','manual','none')),
  user_confirmed    boolean NOT NULL DEFAULT false,
  flags             text[] NOT NULL DEFAULT '{}',
  -- Per-dataset ResultState. Never collapse to a boolean: "checked, none" and
  -- "could not check" are different answers.
  states            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS site_profile_uprn_idx ON site_profile (uprn);
CREATE INDEX IF NOT EXISTS site_profile_latlng_idx ON site_profile (lat, lng);

CREATE TABLE IF NOT EXISTS site_profile_source (
  id              bigserial PRIMARY KEY,
  site_profile_id bigint NOT NULL REFERENCES site_profile(id) ON DELETE CASCADE,
  source_id       text NOT NULL,
  dataset         text NOT NULL,
  entity_ref      text,
  licence         text NOT NULL,
  attribution     text NOT NULL,
  retrieved_at    timestamptz NOT NULL,
  source_updated  timestamptz,
  method          text NOT NULL,
  tier            text NOT NULL CHECK (tier IN ('T1','T2','T3','T4','stale'))
);

CREATE INDEX IF NOT EXISTS site_profile_source_profile_idx
  ON site_profile_source (site_profile_id);
