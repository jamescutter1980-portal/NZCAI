-- S-04: corporate ownership.
--
-- CCOD (UK companies) and OCOD (overseas companies) are both keyed by title
-- number. Open polygon data carries no title number - INSPIRE polygons have a
-- Land Registry-INSPIRE ID, and the title linkage sits in the chargeable
-- National Polygon Service - so the only free route from a building to an owner
-- is to match on the property address these datasets carry as free text.
--
-- That is why `postcode` is indexed and the address is kept verbatim: the
-- postcode narrows the candidate set and the address is scored in application
-- code. Every resulting match is inferred (tier T3), never authoritative.

CREATE TABLE IF NOT EXISTS corporate_title (
  title_number          text PRIMARY KEY,
  dataset               text NOT NULL CHECK (dataset IN ('ccod','ocod')),
  tenure                text,
  property_address      text,
  postcode              text,
  district              text,
  county                text,
  region                text,
  multiple_address      boolean NOT NULL DEFAULT false,
  price_paid            numeric(14,2),
  -- Up to four proprietors per title, kept as one document rather than four
  -- repeated column groups.
  proprietors           jsonb NOT NULL DEFAULT '[]'::jsonb,
  date_proprietor_added date,
  loaded_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS corporate_title_postcode_idx ON corporate_title (postcode);
CREATE INDEX IF NOT EXISTS corporate_title_dataset_idx ON corporate_title (dataset);
-- Supports "what else does this company own", which is the portfolio question.
CREATE INDEX IF NOT EXISTS corporate_title_proprietors_idx
  ON corporate_title USING GIN (proprietors jsonb_path_ops);
