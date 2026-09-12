-- S-05: EPC and building performance.
--
-- Task 0 stored the certificate's identity fields, because what it needed was
-- the address-to-UPRN link. Screening a building's performance needs the
-- numbers behind the band, so they are added here rather than re-derived.
--
-- WHY main_fuel MATTERS MORE THAN IT LOOKS. The non-domestic rating is a CO2
-- rate (BER) against a notional building (TER). A gas-heated building's BER is
-- driven by its heating fuel, and rooftop PV displaces electricity, not gas.
-- So the fuel decides whether an EPC band is reachable by the measure this
-- whole module exists to site. It is a screening input, not a label.
--
-- Every column is nullable on purpose: the three registers publish different
-- fields, and an absent value must stay distinguishable from a zero.

ALTER TABLE epc_certificate
  ADD COLUMN IF NOT EXISTS main_fuel          text,
  -- Building Emission Rate, kgCO2/m2/yr. The rating is derived from this.
  ADD COLUMN IF NOT EXISTS building_emissions numeric(14,3),
  -- Target Emission Rate for the notional building, same units.
  ADD COLUMN IF NOT EXISTS target_emissions   numeric(14,3),
  -- Standard Emission Rate, same units.
  ADD COLUMN IF NOT EXISTS standard_emissions numeric(14,3),
  -- Primary energy use, kWh/m2/yr. The secondary metric on a non-domestic EPC.
  ADD COLUMN IF NOT EXISTS primary_energy     numeric(14,2),
  -- e.g. "Mandatory issue (Marketed sale)". Says why the EPC exists.
  ADD COLUMN IF NOT EXISTS transaction_type   text;

-- Screening a portfolio reads band + fuel together, and the band is stored as
-- the register published it.
CREATE INDEX IF NOT EXISTS epc_certificate_rating_fuel_idx
  ON epc_certificate (rating, main_fuel);
