-- S-06: VOA floor area and use class.
--
-- The published rating list carries VOA's own UARN, not a UPRN - the cross
-- reference lives in OS AddressBase Premium, a paid product - so assessments
-- are matched to sites by address, exactly as ownership is in S-04. Postcode is
-- therefore the indexed narrowing key.
--
-- Survey lines are kept as rows rather than a single total because each line
-- carries its own measurement basis (GIA, NIA, GEA, EFA) and those are not
-- interchangeable. Summing across bases would be arithmetic on incompatible
-- quantities.

CREATE TABLE IF NOT EXISTS voa_assessment (
  uarn                text PRIMARY KEY,
  billing_authority_code      text,
  billing_authority_reference text,
  -- Valuation description, e.g. "WAREHOUSE AND PREMISES". NOT a planning use class.
  primary_description text,
  scat_code           text,
  property_address    text,
  postcode            text,
  rateable_value      numeric(14,2),
  effective_date      date,
  list_year           integer,
  loaded_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voa_assessment_postcode_idx ON voa_assessment (postcode);
CREATE INDEX IF NOT EXISTS voa_assessment_description_idx ON voa_assessment (primary_description);

CREATE TABLE IF NOT EXISTS voa_survey_line (
  id             bigserial PRIMARY KEY,
  uarn           text NOT NULL REFERENCES voa_assessment(uarn) ON DELETE CASCADE,
  line_no        integer NOT NULL,
  description    text,
  area_m2        numeric(14,3),
  -- Never default this. An unstated basis is reported as unknown so the number
  -- is not mistaken for a GIA it may not be.
  basis          text NOT NULL DEFAULT 'unknown'
                   CHECK (basis IN ('GIA','NIA','GEA','EFA','unknown')),
  price_per_m2   numeric(14,2),
  value          numeric(14,2),
  UNIQUE (uarn, line_no)
);

CREATE INDEX IF NOT EXISTS voa_survey_line_uarn_idx ON voa_survey_line (uarn);
