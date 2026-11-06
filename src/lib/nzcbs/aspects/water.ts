import { aspectResult, reported, round, sum } from "../findings";
import type { LimitContext } from "../limits";
import type { AspectResult, BuildingProfile, Finding, WaterInput } from "../types";

/** 5.4 Operational water use: reporting only; no limits in this version (5.4.6). */
export function assessWater(profile: BuildingProfile, ctx: LimitContext, input: WaterInput | undefined): AspectResult {
  const findings: Finding[] = [];
  const warnings: string[] = [];
  if (!input) {
    findings.push(reported({ id: "wa.total", section: "5.4.2", metric: "Annual operational water use", value: null, unit: "m3/yr", reason: "No water data was supplied. All water within the curtilage, including rainwater, greywater and treated blackwater, is in scope (5.4.1.2)." }));
    return aspectResult("operational_water", "5.4", "Operational water use", findings, warnings);
  }
  const inScope = input.sources.filter((s) => !s.excludedProcess);
  const total = round(sum(inScope.map((s) => s.m3)));
  const gia = profile.giaM2;
  findings.push(reported({ id: "wa.total", section: "5.4.2", metric: "Annual operational water use", value: total, unit: "m3/yr", reason: `By source: ${inScope.map((s) => `${s.source} ${s.m3}`).join("; ") || "none"}.`, basis: "Meter readings per source (Table 15)." }));
  findings.push(reported({ id: "wa.per_gia", section: "5.4.2", metric: "Annual operational water use per m2 GIA", value: gia > 0 ? round(total / gia, 4) : null, unit: "m3/m2GIA/yr", reason: gia > 0 ? "" : "No GIA recorded." }));

  // Carbon (5.4.3.1): supply per source, treatment on metered disposal or on total consumption less on-site disposal.
  let carbon: number | null = 0;
  for (const s of inScope) {
    if (s.supplyFactorKgCo2ePerM3 === null || s.supplyFactorKgCo2ePerM3 === undefined) {
      carbon = null;
      warnings.push(`No supply emission factor for ${s.source} water; use the DESNZ "water supply" factor or an equivalent-scope source factor (5.4.3.1).`);
      break;
    }
    carbon += s.m3 * s.supplyFactorKgCo2ePerM3;
  }
  const disposalM3 = input.meteredDisposalM3 ?? Math.max(0, total - (input.onsiteDisposalM3 ?? 0));
  if (carbon !== null) {
    if (input.treatmentFactorKgCo2ePerM3 === null || input.treatmentFactorKgCo2ePerM3 === undefined) {
      carbon = null;
      warnings.push('No water treatment emission factor; use the DESNZ "water treatment" factor (5.4.3.1).');
    } else {
      carbon += disposalM3 * input.treatmentFactorKgCo2ePerM3;
    }
  }
  findings.push(reported({ id: "wa.carbon_per_gia", section: "5.4.3.1", metric: "Annual operational water use carbon emissions per m2 GIA", value: carbon !== null && gia > 0 ? round(carbon / gia, 4) : null, unit: "kgCO2e/m2GIA/yr", reason: carbon === null ? "An emission factor is missing." : `${round(carbon)} kgCO2e: supply on ${total} m3 and treatment on ${round(disposalM3)} m3 (${input.meteredDisposalM3 !== undefined ? "metered disposal" : "total consumption less on-site disposal"}).` }));

  const classification = ctx.sectors.classification;
  if (classification === "Homes" || classification === "Offices") {
    findings.push(reported({ id: "wa.per_person_day", section: "5.4.2", metric: "Litres per person per day", value: input.residents ? round((total * 1000) / input.residents / 365, 1) : null, unit: "l/person/day", reason: input.residents ? `${input.residents} typical residents or occupants over 365 days.` : "Typical number of residents or occupants not supplied." }));
  }
  if (classification === "Schools") {
    findings.push(reported({ id: "wa.per_pupil", section: "5.4.2", metric: "Annual operational water use per pupil", value: input.pupils ? round(total / input.pupils, 3) : null, unit: "m3/pupil/yr", reason: input.pupils ? `${input.pupils} pupils registered.` : "Number of pupils not supplied." }));
  }
  if (classification === "Data Centres") {
    findings.push(reported({ id: "wa.wue", section: "5.4.2", metric: "Water Use Effectiveness", value: input.itEnergyKwh ? round((total * 1000) / input.itEnergyKwh, 4) : null, unit: "WUE (l/kWh IT)", reason: input.itEnergyKwh ? "Litres of water per kWh of IT energy." : "IT energy not supplied." }));
  }
  return aspectResult("operational_water", "5.4", "Operational water use", findings, warnings);
}
