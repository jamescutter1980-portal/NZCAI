-- Task 0: the EPC register.
--
-- Certificates are cached per postcode so the resolution chain, MEES work and
-- the floor-area comparison all read the same rows rather than each calling the
-- register.
--
-- uprn_source is stored, not collapsed. The register distinguishes a UPRN it
-- matched algorithmically ("Address Matched") from one an energy assessor typed
-- in, and those are not the same grade of identifier - the first is treated as
-- register-grade, the second as inferred.

CREATE TABLE IF NOT EXISTS epc_certificate (
  lmk_key            text PRIMARY KEY,
  register           text NOT NULL CHECK (register IN ('domestic','non-domestic','display')),
  address            text,
  postcode           text,
  uprn               text,
  uprn_source        text NOT NULL DEFAULT 'unknown'
                       CHECK (uprn_source IN ('address_matched','energy_assessor','unknown','none')),
  rating             text,
  asset_rating       numeric(10,2),
  floor_area_m2      numeric(14,2),
  inspection_date    date,
  lodgement_date     date,
  property_type      text,
  building_reference text,
  retrieved_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS epc_certificate_postcode_idx ON epc_certificate (postcode);
CREATE INDEX IF NOT EXISTS epc_certificate_uprn_idx ON epc_certificate (uprn);
CREATE INDEX IF NOT EXISTS epc_certificate_recency_idx
  ON epc_certificate (postcode, inspection_date DESC NULLS LAST);

-- The resolved street address, which arrives with the register and is what
-- lifts S-04 and S-06 out of postcode-only matching.
ALTER TABLE site_profile ADD COLUMN IF NOT EXISTS address text;
