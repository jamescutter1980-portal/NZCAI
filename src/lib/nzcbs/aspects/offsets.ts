import { OFFSET_VINTAGE_WINDOW_YEARS } from "../constants";
import { aspectResult, notApplicable, reported, requirement, round, sum } from "../findings";
import type { AspectResult, Finding, OffsetInput } from "../types";

/**
 * 5.10 Carbon offsetting: optional. Where used, credits must be ICROA or
 * ICVCM, within five years of the RPEP, retired for these emissions, and the
 * quantity must equal the in-scope total; renewable procurement may cover
 * grid electricity Scope 2 only, and only for the part of the ORP it covers.
 */
export function assessOffsets(input: OffsetInput | undefined, rpep: string): AspectResult {
  const findings: Finding[] = [];
  const warnings: string[] = [];
  if (!input || (input.credits.length === 0 && !(input.procurement?.length))) {
    findings.push(notApplicable({ id: "of.scope", section: "5.10.1.1", metric: "Carbon offsetting", reason: 'No offsetting is claimed, so section 5.10 does not apply and the claim cannot carry "(plus offsets)".', kind: "requirement" }));
    return aspectResult("carbon_offsetting", "5.10", "Carbon offsetting", findings, warnings);
  }
  const rpepYear = Number(rpep.slice(0, 4));
  let validCreditsKg = 0;
  for (const c of input.credits) {
    const problems: string[] = [];
    if (c.scheme === "other") problems.push("not from an ICROA-endorsed standard or an ICVCM Core Carbon Principle label (5.10.2.1)");
    if (Math.abs(c.vintageYear - rpepYear) > OFFSET_VINTAGE_WINDOW_YEARS) problems.push(`vintage ${c.vintageYear} is more than ${OFFSET_VINTAGE_WINDOW_YEARS} years from the RPEP year ${rpepYear}`);
    if (!c.retired) problems.push("not retired");
    const ok = problems.length === 0;
    if (ok) validCreditsKg += c.tonnesCo2e * 1000;
    findings.push(requirement({ id: `of.credit.${c.registryReference ?? `${c.scheme}_${c.vintageYear}`}`.replace(/[^A-Za-z0-9_.]+/g, "_"), section: "5.10.2.1", metric: `Credits ${c.registryReference ?? ""} ${c.tonnesCo2e} tCO2e (${c.scheme}, vintage ${c.vintageYear})`, met: ok, reason: ok ? "Eligible credits, retired for the in-scope emissions." : `Not eligible: ${problems.join("; ")}.` }));
  }
  let procurementKg = 0;
  for (const p of input.procurement ?? []) {
    const problems: string[] = [];
    if (p.type === "ukgbc_silver_or_gold" && !p.confirmedByExpert) problems.push("the UKGBC rating must be confirmed by a procurement expert with at least three years' experience");
    if (p.type === "deep_green_rego_tariff" && !p.regosRetired) problems.push("all REGOs from UK generators must be retired and the tariff must be Deep Green");
    if (p.type === "direct_ppa" && !p.ppaWithinThreeYearsOfConstruction) problems.push("the PPA must have been entered within three years of the generator's construction");
    const ok = problems.length === 0;
    findings.push(requirement({ id: `of.procurement.${p.type}`, section: "5.10.2.2", metric: `Renewable electricity procurement (${p.type.replace(/_/g, " ")}) covering ${p.kwhCovered} kWh`, met: ok, reason: ok ? `Eligible; covers ${Math.round(p.orpCoverage * 100)}% of the ORP, so only that share of grid electricity Scope 2 may be offset this way.` : `Not eligible: ${problems.join("; ")}.` }));
    if (ok && input.gridElectricityScope2KgCo2e !== undefined) procurementKg += input.gridElectricityScope2KgCo2e * Math.min(1, Math.max(0, p.orpCoverage));
  }
  procurementKg = Math.min(procurementKg, input.gridElectricityScope2KgCo2e ?? 0);
  if (procurementKg > 0) warnings.push("Renewable procurement covers grid electricity Scope 2 only; T&D and WTT emissions must be offset with carbon credits (5.10.2.2).");
  const covered = round(validCreditsKg + procurementKg);
  findings.push(reported({ id: "of.in_scope", section: "5.10.1.2", metric: "Total in-scope carbon emissions", value: input.inScopeEmissionsKgCo2e, unit: "kgCO2e", reason: "Upfront carbon, operational energy, water and Kyoto refrigerant leakage as a minimum." }));
  findings.push(requirement({ id: "of.quantity", section: "5.10.2.3", metric: "Offsets equal the in-scope emissions", met: covered >= input.inScopeEmissionsKgCo2e, reason: `${covered} kgCO2e covered (${round(validCreditsKg)} by eligible credits${procurementKg ? `, ${round(procurementKg)} by eligible procurement` : ""}) against ${input.inScopeEmissionsKgCo2e} kgCO2e in scope.` }));
  return aspectResult("carbon_offsetting", "5.10", "Carbon offsetting", findings, warnings);
}

export const offsetsTotal = (input: OffsetInput) => sum(input.credits.map((c) => c.tonnesCo2e * 1000));
