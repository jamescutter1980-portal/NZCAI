import { REFRIGERANT_CHARGE_REPORTING_THRESHOLD_KGCO2E, REFRIGERANT_EXCEPTION_RPEP_BEFORE, VERSION_1_PUBLICATION_DATE } from "../constants";
import { aspectResult, compare, reported, requirement, round, sum } from "../findings";
import type { LimitContext } from "../limits";
import type { AspectResult, Finding, RefrigerantInput, RefrigerantSystem } from "../types";

/**
 * 5.9 Refrigerants: GWP of each in-scope system against the Annex A4 limit
 * (Equation 8 charge, Equations 9a to 9c leakage where the building's charge
 * is 3,000 kgCO2e or more).
 */

/** Equation 9a where start, added and end are all known; Equation 9b otherwise. */
export function leakageKg(s: RefrigerantSystem): { kg: number | null; equation: "9a" | "9b" | null; reason: string } {
  if (s.startChargeKg !== undefined && s.addedKg !== undefined && s.endChargeKg !== undefined) {
    const kg = round(s.startChargeKg + s.addedKg - s.endChargeKg, 4);
    return { kg, equation: "9a", reason: `Equation 9a: ${s.startChargeKg} + ${s.addedKg} - ${s.endChargeKg} = ${kg} kg.` };
  }
  if (s.addedKg !== undefined) return { kg: round(s.addedKg, 4), equation: "9b", reason: `Equation 9b: quantity added ${s.addedKg} kg.` };
  return { kg: null, equation: null, reason: "No refrigerant added or start and end charge recorded for the ORP; servicing records are a submission item (5.9.5)." };
}

export function gwpException(s: RefrigerantSystem, rpep: string): { allowed: boolean; reason: string } {
  if (s.exception === "cannot_retrofit") return { allowed: true, reason: "Exception: it is not possible to retrofit the system to a replacement refrigerant for health and safety or physical site reasons (5.9.6); evidence required." };
  if (s.exception === "installed_before_v1_no_works") {
    const before = !!s.installDate && s.installDate < VERSION_1_PUBLICATION_DATE;
    const rpepOk = rpep < REFRIGERANT_EXCEPTION_RPEP_BEFORE;
    if (before && rpepOk) return { allowed: true, reason: `Exception: installed ${s.installDate}, before Version 1, with no works since, and the RPEP is before 1 January 2030 (5.9.6).` };
    return { allowed: false, reason: !before ? `The pre-Version-1 exception needs an installation date before ${VERSION_1_PUBLICATION_DATE}; recorded: ${s.installDate ?? "none"}.` : `The pre-Version-1 exception lapses for an RPEP on or after ${REFRIGERANT_EXCEPTION_RPEP_BEFORE}.` };
  }
  return { allowed: false, reason: "" };
}

export function assessRefrigerants(ctx: LimitContext, input: RefrigerantInput | undefined, rpep: string): AspectResult {
  const findings: Finding[] = [];
  const warnings: string[] = [];
  const gwpLimit = ctx.gwpLimit.value;
  if (!input) {
    findings.push(compare({ id: "rf.gwp", section: "5.9.6", metric: "GWP of refrigerants in each in-scope system", value: null, limit: gwpLimit, unit: "kgCO2e/kg", reason: "", missingValue: "No refrigerant system register was supplied. Every fixed air conditioning, heat pump, chiller, VRF and refrigeration system is in scope (5.9.1.2)." }));
    return aspectResult("refrigerants", "5.9", "Refrigerants", findings, warnings);
  }
  if (input.systems.length === 0) {
    findings.push(requirement({ id: "rf.none", section: "5.9.1.2", metric: "In-scope refrigerant systems", met: true, reason: "No system containing refrigerant is recorded. A written statement to that effect is a submission item (5.9.5)." }));
    return aspectResult("refrigerants", "5.9", "Refrigerants", findings, warnings);
  }
  // Equation 8.
  const charge = round(sum(input.systems.map((s) => s.chargeKg * s.gwp)));
  findings.push(reported({ id: "rf.charge", section: "5.9.1.2", metric: "Refrigerant gas charge in the building", value: charge, unit: "kgCO2e", reason: `Equation 8 across ${input.systems.length} system(s): ${input.systems.map((s) => `${s.id} ${s.chargeKg} kg x ${s.gwp}`).join("; ")}.` }));

  for (const s of input.systems) {
    const f = compare({ id: `rf.gwp.${s.id}`, section: "5.9.6", metric: `${s.id} (${s.systemType}, ${s.refrigerant}): GWP`, value: s.gwp, limit: gwpLimit, unit: "kgCO2e/kg", reason: `GWP ${s.gwp} against the Annex A4 limit ${gwpLimit}. ${ctx.gwpLimit.note}`, missingLimit: "No GWP limit loaded." });
    if (f.status === "fail") {
      const ex = gwpException(s, rpep);
      if (ex.allowed) {
        f.status = "pass";
        f.reason = `GWP ${s.gwp} exceeds the limit ${gwpLimit}. ${ex.reason}`;
      } else if (ex.reason) {
        f.reason += ` ${ex.reason}`;
      }
      findings.push(f);
      findings.push(requirement({ id: `rf.leak_detection.${s.id}`, section: "5.9.6", metric: `${s.id}: leak detection fitted`, met: s.leakDetectionFitted ?? null, reason: s.leakDetectionFitted ? "Leak detection fitted to shut the system down on a leak." : "Where the GWP limit is exceeded the system shall be fitted with leak detection that facilitates shutdown (5.9.6)." }));
    } else {
      findings.push(f);
    }
  }

  // Leakage reporting (5.9.3) where the charge reaches the threshold.
  if (charge >= REFRIGERANT_CHARGE_REPORTING_THRESHOLD_KGCO2E) {
    const byRefrigerant = new Map<string, { kg: number; kgCo2e: number; kyoto: boolean }>();
    let missing = false;
    for (const s of input.systems) {
      const l = leakageKg(s);
      if (l.kg === null) {
        missing = true;
        warnings.push(`${s.id}: ${l.reason}`);
        continue;
      }
      const e = byRefrigerant.get(s.refrigerant) ?? { kg: 0, kgCo2e: 0, kyoto: s.kyoto ?? true };
      e.kg += l.kg;
      e.kgCo2e += l.kg * s.gwp;
      byRefrigerant.set(s.refrigerant, e);
    }
    const kyoto = round(sum([...byRefrigerant.values()].filter((e) => e.kyoto).map((e) => e.kgCo2e)));
    const other = round(sum([...byRefrigerant.values()].filter((e) => !e.kyoto).map((e) => e.kgCo2e)));
    findings.push(reported({ id: "rf.leakage_kyoto", section: "5.9.3", metric: "Annual carbon impact of refrigerant leakage, Kyoto protocol gases", value: missing && byRefrigerant.size === 0 ? null : kyoto, unit: "kgCO2e/yr", reason: `Charge ${charge} kgCO2e is at or above ${REFRIGERANT_CHARGE_REPORTING_THRESHOLD_KGCO2E}, so leakage is assessed. Per refrigerant: ${[...byRefrigerant.entries()].map(([r, e]) => `${r} ${round(e.kg, 4)} kg = ${round(e.kgCo2e)} kgCO2e`).join("; ") || "none"}.${missing ? " Some systems have no leakage data, so the total is incomplete." : ""}`, basis: "Equation 9c with GWP from the DESNZ full set." }));
    if (other > 0) findings.push(reported({ id: "rf.leakage_other", section: "5.9.3", metric: "Annual carbon impact of refrigerant leakage, other gases", value: other, unit: "kgCO2e/yr", reason: "Optional reporting for non-Kyoto gases." }));
  } else {
    warnings.push(`Charge ${charge} kgCO2e is below ${REFRIGERANT_CHARGE_REPORTING_THRESHOLD_KGCO2E}, so leakage carbon is not required; the GWP limit still applies to every system (5.9.6 note 1).`);
  }
  return aspectResult("refrigerants", "5.9", "Refrigerants", findings, warnings);
}
