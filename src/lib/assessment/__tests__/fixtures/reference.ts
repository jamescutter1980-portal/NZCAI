import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Synthetic reference data for the assessment tests.
 *
 * EVERY number below is made up (the 1.111 / 2.222 / 9.999 style makes that
 * obvious). None of it is a real DESNZ factor, CRREM pathway value or UK
 * NZCBS limit, and none of it may be copied into data/reference. The tests
 * exercise plumbing, selection and null handling, never numerical accuracy.
 * No network is used: every file is written into a temp directory that is
 * passed to the code as REFERENCE_DATA_DIR.
 */

export const DESNZ_CSV = `ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,GHG Conversion Factor 2026
1,Scope 2,UK electricity,Electricity generated,,,,kWh,kg CO2e,0.111
2,Scope 3,Transmission and distribution,T&D- UK electricity,,,,kWh,kg CO2e,0.011
3,Scope 1,Fuels,Gaseous fuels,Natural gas,,,kWh (Gross CV),kg CO2e,0.222
`;

/**
 * GB Office falls below the asset's synthetic intensity part way through;
 * GB Warehouse is set absurdly high so nothing ever crosses it.
 */
export const CRREM_CSV = `version,country_code,property_type,pathway_type,scenario,year,value,unit
v9.99,GB,Office,ghg,1.5C,2025,4.400,kgCO2e/m2
v9.99,GB,Office,ghg,1.5C,2026,3.300,kgCO2e/m2
v9.99,GB,Office,ghg,1.5C,2027,2.500,kgCO2e/m2
v9.99,GB,Office,ghg,1.5C,2028,2.222,kgCO2e/m2
v9.99,GB,Office,ghg,1.5C,2029,1.111,kgCO2e/m2
v9.99,GB,Office,ghg,1.5C,2030,1.000,kgCO2e/m2
v9.99,GB,Office,energy,1.5C,2026,19.990,kWh/m2
v9.99,GB,Office,energy,1.5C,2027,9.990,kWh/m2
v9.99,GB,Warehouse,ghg,1.5C,2026,99.900,kgCO2e/m2
v9.99,GB,Warehouse,ghg,1.5C,2027,99.900,kgCO2e/m2
v9.99,GB,Warehouse,ghg,1.5C,2028,99.900,kgCO2e/m2
`;

export const NZCBS_CSV = `version,sector,metric,year,limit_value,unit,notes
v1.0,Office,operational_energy_eui,2026,11.110,kWh/m2/yr,Synthetic limit; not the published Standard
v1.0,Office,embodied_upfront,2026,222.200,kgCO2e/m2,Synthetic A1-A5 limit
v1.0,Office,onsite_renewables,2026,,kWh/m2/yr,No limit set in this synthetic table
v1.0,Retail,operational_energy_eui,2026,55.500,kWh/m2/yr,Synthetic limit
v1.0,Retail,embodied_upfront,2030,111.100,kgCO2e/m2,Synthetic limit for a later year only
`;

/** Writes the synthetic files into `dir`, which the tests pass as REFERENCE_DATA_DIR. */
export function writeReferenceFixtures(dir: string, which: { desnz?: boolean; crrem?: boolean; nzcbs?: boolean } = {}): void {
  const { desnz = true, crrem = true, nzcbs = true } = which;
  if (desnz) {
    mkdirSync(join(dir, "desnz-conversion-factors"), { recursive: true });
    writeFileSync(join(dir, "desnz-conversion-factors", "2026.csv"), DESNZ_CSV);
  }
  if (crrem) {
    mkdirSync(join(dir, "crrem-pathways"), { recursive: true });
    writeFileSync(join(dir, "crrem-pathways", "v9.99.csv"), CRREM_CSV);
  }
  if (nzcbs) {
    mkdirSync(join(dir, "uk-nzcbs"), { recursive: true });
    writeFileSync(join(dir, "uk-nzcbs", "v1.0.csv"), NZCBS_CSV);
  }
}
