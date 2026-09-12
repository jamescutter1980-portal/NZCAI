-- S-08: the MEES prospect list.
--
-- CORPUS CHOICE, AND WHY IT IS NOT THE VOA RATING LIST.
--
-- S-07 searches the VOA list and joins an EPC band by postcode, which is a
-- lead. That is fine for "find me warehouses"; it is not fine here. A MEES
-- prospect list names a building and states its band, so a band matched to the
-- wrong building would put a specific address on a list of F and G rated stock
-- because its neighbour is rated F.
--
-- The EPC register does not need the join at all: the certificate carries the
-- address, the floor area, the fuel and the band in one record. So the corpus
-- for S-08 is the register itself, and VOA is optional enrichment at address-
-- match quality, marked as such.
--
-- WHAT THIS TABLE ACTUALLY IS. epc_certificate is a CACHE, filled per postcode
-- by lookups and by the bulk loader. Its coverage is whatever has been loaded,
-- never the country, and every S-08 result has to say so.

-- The corpus scan filters to non-domestic and orders within a postcode
-- district, so the index carries both. Partial, because domestic certificates
-- and DECs are not screened here.
CREATE INDEX IF NOT EXISTS epc_certificate_nondom_idx
  ON epc_certificate (postcode, lodgement_date DESC NULLS LAST)
  WHERE register = 'non-domestic';

-- Cohort filtering reads the band and the floor area together.
CREATE INDEX IF NOT EXISTS epc_certificate_nondom_band_idx
  ON epc_certificate (rating, floor_area_m2)
  WHERE register = 'non-domestic';

-- Records a bulk load so the corpus can say where it came from and when,
-- rather than presenting a partial import as a complete picture.
CREATE TABLE IF NOT EXISTS epc_bulk_load (
  id           bigserial PRIMARY KEY,
  source_file  text NOT NULL,
  register     text NOT NULL,
  rows_read    integer NOT NULL DEFAULT 0,
  rows_loaded  integer NOT NULL DEFAULT 0,
  rows_skipped integer NOT NULL DEFAULT 0,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  note         text
);
