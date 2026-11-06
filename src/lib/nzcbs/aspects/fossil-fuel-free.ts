import { aspectResult, reported, requirement, round, sum } from "../findings";
import type { AspectResult, Finding, FossilFuel, FossilFuelInput, FossilFuelSystem } from "../types";

/**
 * 5.5 Fossil fuel free: fossil fuels and first-generation biofuels may not be
 * used on site except in the 5.5.5 allowable cases; second-generation and
 * waste-derived biofuels need UK or EEA feedstock and low-iLUC certification.
 */

const FOSSIL: FossilFuel[] = ["natural_gas", "oil", "lpg", "coal", "other_fossil", "biofuel_first_generation"];

export function systemVerdict(s: FossilFuelSystem): { allowed: boolean; reason: string } {
  if (FOSSIL.includes(s.fuel)) {
    if (s.exception) return { allowed: true, reason: `${s.fuel.replace(/_/g, " ")} allowed under the 5.5.5 case "${s.exception.replace(/_/g, " ")}"; still measured and reported (5.5.1.1).` };
    return { allowed: false, reason: `${s.fuel.replace(/_/g, " ")} is used on site for an in-scope use with no 5.5.5 allowable case recorded${s.fuel === "biofuel_first_generation" ? " (first-generation biofuels are treated as fossil fuels)" : ""}.` };
  }
  // Second-generation or waste-derived biofuel.
  const b = s.biofuel;
  if (!b) return { allowed: false, reason: `${s.fuel.replace(/_/g, " ")}: feedstock origin and certification evidence are missing (5.5.4, 5.5.5).` };
  const origin = b.feedstockOrigin === "UK" || b.feedstockOrigin === "EEA";
  if (!origin) return { allowed: false, reason: "Biofuel feedstock is not from the United Kingdom or the European Economic Area (5.5.5)." };
  if (!b.certifiedLowIlucRisk) return { allowed: false, reason: "Biofuel is not shown to have low indirect land-use change risk under a scheme approved under the EU Renewable Energy Directive (5.5.5)." };
  return { allowed: true, reason: `${s.fuel.replace(/_/g, " ")} from ${b.feedstockOrigin} feedstock with low-iLUC certification; feedstock classification, origin, chain of custody and carbon factors are submission items (5.5.4).` };
}

export function assessFossilFuelFree(input: FossilFuelInput | undefined): AspectResult {
  const findings: Finding[] = [];
  const warnings: string[] = [];
  if (!input) {
    findings.push(requirement({ id: "ff.statement", section: "5.5.5", metric: "No fossil fuel use on site beyond the allowable cases", met: null, reason: "No fossil fuel review was supplied. The review covers drawings, specifications, energy-using systems and meter records (5.5.2.1)." }));
    return aspectResult("fossil_fuel_free", "5.5", "Fossil fuel free", findings, warnings);
  }
  for (const s of input.systems) {
    const v = systemVerdict(s);
    findings.push(requirement({ id: `ff.system.${slug(s.description)}`, section: "5.5.5", metric: `System: ${s.description}`, met: v.allowed, reason: v.reason }));
  }
  // An undeclared fossil supply in the energy data.
  const fossilSupplies = (input.supplies ?? []).filter((s) => (s.kind === "natural_gas" || s.kind === "bulk_fuel") && s.kwh > 0);
  const declaredFuels = new Set(input.systems.map((s) => s.fuel));
  for (const s of fossilSupplies) {
    const fuel: FossilFuel = s.kind === "natural_gas" ? "natural_gas" : guessFuel(s.fuel);
    if (!declaredFuels.has(fuel)) {
      findings.push(requirement({ id: `ff.supply.${s.kind}${s.fuel ? `.${slug(s.fuel)}` : ""}`, section: "5.5.2.1", metric: `${s.kind === "natural_gas" ? "Natural gas" : s.fuel ?? "Bulk fuel"} supply in the energy data`, met: false, reason: `${round(s.kwh)} kWh of ${s.kind === "natural_gas" ? "natural gas" : s.fuel ?? "bulk fuel"} was used in the ORP but no system using it is in the fossil fuel review. Record the system and its 5.5.5 case, or the building fails the fossil-fuel-free requirement.` }));
    }
  }
  const fossilKwh = round(sum(fossilSupplies.map((s) => s.kwh)));
  if (fossilKwh > 0) findings.push(reported({ id: "ff.fossil_kwh", section: "5.5.1.1", metric: "Fossil fuel and biofuel energy used on site", value: fossilKwh, unit: "kWh/yr", reason: "Measured, assessed and reported whatever the exception (5.5.1.1; 5.2.3.3 note 1)." }));
  if (input.systems.length === 0 && fossilSupplies.length === 0) {
    findings.push(requirement({ id: "ff.statement", section: "5.5.4", metric: "Statement that there is no fossil fuel use on site", met: true, reason: "No fossil fuel or biofuel system declared and no fossil supply in the energy data. The statement needs drawings, specifications and meter records as evidence (5.5.4)." }));
  }
  return aspectResult("fossil_fuel_free", "5.5", "Fossil fuel free", findings, warnings);
}

function guessFuel(name: string | undefined): FossilFuel {
  const n = (name ?? "").toLowerCase();
  if (/lpg|propane|butane/.test(n)) return "lpg";
  if (/coal/.test(n)) return "coal";
  if (/oil|kerosene|diesel/.test(n)) return "oil";
  if (/pellet|chip|wood|biomass|biogas|hvo|biodiesel/.test(n)) return "biofuel_second_generation";
  return "other_fossil";
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
