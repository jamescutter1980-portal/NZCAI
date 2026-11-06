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

/**
 * Writes the synthetic files into `dir`, which the tests pass as REFERENCE_DATA_DIR.
 * The UK NZCBS tables are not synthetic: the engine reads the bundled, checksummed
 * Rev 1 tables under reference/uk-nzcbs, so nothing is written for them here.
 */
export function writeReferenceFixtures(dir: string, which: { desnz?: boolean; crrem?: boolean } = {}): void {
  const { desnz = true, crrem = true } = which;
  if (desnz) {
    mkdirSync(join(dir, "desnz-conversion-factors"), { recursive: true });
    writeFileSync(join(dir, "desnz-conversion-factors", "2026.csv"), DESNZ_CSV);
  }
  if (crrem) {
    mkdirSync(join(dir, "crrem-pathways"), { recursive: true });
    writeFileSync(join(dir, "crrem-pathways", "v9.99.csv"), CRREM_CSV);
  }
}
