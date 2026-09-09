import type { OperationContext } from "@/lib/integrations/framework";
import { loadYears, type FactorRow, type YearIndex } from "@/lib/integrations/desnz-conversion-factors";
import { parseResidualMix, type ResidualMixRow } from "@/lib/integrations/aib-residual-mix";
import { listReferenceFiles, loadReferenceFile } from "@/lib/integrations/_shared/reference-data";
import type { Basis } from "@/lib/provenance";

/**
 * Resolves the emission factors the portal's Scope 1 and 2 calculations
 * need from the versioned reference files, never from hard-coded numbers.
 */
export interface ResolvedFactor {
  value: number | null;
  unit: string;
  basis: Basis;
  source: string;
  /** Publication, year, file and row id so the number is traceable. */
  reference: string;
  detail?: string;
}

interface FactorSpec {
  level1: string;
  level2?: string;
  level3?: string;
  uom: string;
  ghgUnit: string;
}

/** Row selectors for the DESNZ flat file, matched case-insensitively on the level and unit text. */
export const DESNZ_SELECTORS = {
  electricityGenerated: { level1: "UK electricity", level2: "Electricity generated", uom: "kWh", ghgUnit: "kg CO2e" },
  electricityTandD: { level1: "Transmission and distribution", level2: "T&D- UK electricity", uom: "kWh", ghgUnit: "kg CO2e" },
  naturalGasGross: { level1: "Fuels", level2: "Gaseous fuels", level3: "Natural gas", uom: "kWh (Gross CV)", ghgUnit: "kg CO2e" },
} as const;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[–—]/g, "-").trim();

export function findDesnzFactor(year: YearIndex, spec: FactorSpec): FactorRow | undefined {
  const match = (row: FactorRow) =>
    norm(row.level1) === norm(spec.level1) &&
    (spec.level2 === undefined || norm(row.level2) === norm(spec.level2)) &&
    (spec.level3 === undefined || norm(row.level3) === norm(spec.level3)) &&
    norm(row.uom) === norm(spec.uom) &&
    norm(row.ghg_unit) === norm(spec.ghgUnit);
  // Prefer the total row ("kg CO2e" with blank level4 / column text), fall back to any exact match.
  const candidates = year.rows.filter(match);
  return candidates.find((r) => !r.level4 && !r.column_text) ?? candidates[0];
}

export function desnzFactor(ctx: OperationContext, reportingYear: number, spec: FactorSpec, label: string): ResolvedFactor {
  const years = loadYears(ctx);
  const year = years.find((y) => y.year === reportingYear);
  if (!year) {
    return { value: null, unit: "kgCO2e/kWh", basis: "unavailable", source: "desnz-conversion-factors", reference: `DESNZ ${reportingYear}`, detail: `No DESNZ ${reportingYear} flat file loaded (loaded: ${years.map((y) => y.year).join(", ") || "none"}).` };
  }
  const row = findDesnzFactor(year, spec);
  if (!row) {
    return { value: null, unit: "kgCO2e/kWh", basis: "unavailable", source: "desnz-conversion-factors", reference: `DESNZ ${reportingYear} (${year.file.name})`, detail: `No row matching "${label}" in the ${reportingYear} flat file.` };
  }
  if (row.availability === "unavailable" || row.factor === null) {
    return { value: null, unit: "kgCO2e/kWh", basis: "unavailable", source: "desnz-conversion-factors", reference: `DESNZ ${reportingYear} row ${row.id}`, detail: `Factor published as not available.` };
  }
  return { value: row.factor, unit: `${row.ghg_unit}/${row.uom}`, basis: "measured", source: "desnz-conversion-factors", reference: `DESNZ ${reportingYear} row ${row.id} (${year.file.name})` };
}

export function residualMixFactor(ctx: OperationContext, dataYear: number, countryCode = "GB"): ResolvedFactor {
  const file = listReferenceFiles(ctx.env, "aib-residual-mix", /\.csv$/i)[0];
  if (!file) {
    return { value: null, unit: "kgCO2e/kWh", basis: "unavailable", source: "aib-residual-mix", reference: `AIB residual mix ${countryCode} ${dataYear}`, detail: "No AIB residual mix file loaded." };
  }
  const rows: ResidualMixRow[] = loadReferenceFile(file, parseResidualMix);
  const match = rows.filter((r) => r.country_code.toUpperCase() === countryCode.toUpperCase() && r.residual_mix_gco2_per_kwh !== null);
  const exact = match.find((r) => r.data_year === dataYear);
  const chosen = exact ?? [...match].sort((a, b) => b.data_year - a.data_year).find((r) => r.data_year < dataYear);
  if (!chosen || chosen.residual_mix_gco2_per_kwh === null) {
    return { value: null, unit: "kgCO2e/kWh", basis: "unavailable", source: "aib-residual-mix", reference: `AIB residual mix ${countryCode} ${dataYear}`, detail: `No ${countryCode} row for ${dataYear} or an earlier year in ${file.name}.` };
  }
  return {
    value: chosen.residual_mix_gco2_per_kwh / 1000,
    unit: "kgCO2e/kWh",
    basis: "measured",
    source: "aib-residual-mix",
    reference: `AIB residual mix ${chosen.country_code} data year ${chosen.data_year}${exact ? "" : " (latest earlier year used)"} (${chosen.publication || file.name})`,
    detail: chosen.direct_co2_only ? "Published value is direct CO2 only." : undefined,
  };
}
