import { aspectResult, compare, notApplicable, reported, requirement, round, sum } from "../findings";
import type { LimitContext } from "../limits";
import type { AspectResult, BuildingProfile, Finding, RenewablesInput } from "../types";

/**
 * 5.3 On-site renewable electricity generation: the Table 13 metrics and the
 * Annex A3 target as reduced under 5.3.5.1 (resolved in the limit context).
 */
export function assessRenewables(profile: BuildingProfile, ctx: LimitContext, input: RenewablesInput | undefined): AspectResult {
  const findings: Finding[] = [];
  const warnings: string[] = [...ctx.renewables.notes];
  const target = ctx.renewables;
  const footprint = profile.footprintM2 ?? null;

  if (!input) {
    findings.push(compare({ id: "re.target", section: "5.3.5.1", metric: "Annual on-site renewable electricity generation per m2 footprint", value: null, limit: target.applies ? target.target : null, unit: target.unit, reason: "", missingValue: "No on-site generation data was supplied. Where there is no system, the target still applies unless reduced under 5.3.5.1; record the constraints and the feasible capacity.", missingLimit: target.notes.join(" ") }));
    return aspectResult("onsite_renewables", "5.3", "On-site renewable electricity generation", findings, warnings);
  }

  const inScope = input.systems.filter((s) => s.consumerSideOfPrimaryMeter !== false);
  const outOfScope = input.systems.filter((s) => s.consumerSideOfPrimaryMeter === false);
  if (outOfScope.length) warnings.push(`${outOfScope.length} system(s) are not connected on the consumer side of the primary meter and are outside the 5.3.1.2 scope.`);
  const generated = round(sum(inScope.map((s) => s.generatedKwh)));
  const exported = round(sum(inScope.map((s) => s.exportedKwh)));
  const used = round(generated - exported);
  const capacity = round(sum(inScope.map((s) => s.capacityKw)));

  findings.push(reported({ id: "re.generated", section: "5.3.2", metric: "Total annual on-site renewable electricity generation", value: generated, unit: "kWh/yr", reason: `${inScope.length} system(s): ${inScope.map((s) => `${s.technology} ${s.capacityKw} kW`).join(", ") || "none"}.`, basis: "Meter readings (Table 11)." }));
  findings.push(reported({ id: "re.used", section: "5.3.2", metric: "Annual on-site renewable electricity generation used on site", value: used, unit: "kWh/yr", reason: "Generation less export (Table 11 note b). Counts in the EUI; exported electricity does not (5.3.1.2)." }));
  findings.push(reported({ id: "re.exported", section: "5.3.2", metric: "Annual on-site renewable electricity generation exported", value: exported, unit: "kWh/yr", reason: "Excluded from energy use; included against the target; reported under module D2 (5.3.1.2)." }));
  findings.push(reported({ id: "re.capacity", section: "5.3.2", metric: "On-site renewable electricity generation capacity per m2 footprint", value: footprint && footprint > 0 ? round(capacity / footprint, 4) : null, unit: "kWp/m2FP", reason: footprint ? `${capacity} kWp over ${footprint} m2 footprint.` : "Building footprint not recorded (5.3.2)." }));

  if (!target.applies) {
    findings.push(notApplicable({ id: "re.target", section: "5.3.5.1", metric: "Annual on-site renewable electricity generation per m2 footprint", reason: target.steps.join(" ") }));
  } else {
    const perFootprint = footprint && footprint > 0 ? round(generated / footprint) : null;
    const f = compare({
      id: "re.target",
      section: "5.3.5.1",
      metric: "Annual on-site renewable electricity generation per m2 footprint",
      value: perFootprint,
      limit: target.target,
      unit: target.unit,
      reason: `${generated} kWh over ${footprint} m2 footprint against the target ${target.target} ${target.unit}. ${target.steps.join(" ")}`,
      missingValue: "Building footprint not recorded, so generation per m2 footprint cannot be calculated.",
      missingLimit: target.notes.join(" ") || "No target could be selected.",
    });
    // The target is a minimum: at or above passes.
    if (f.status === "pass" || f.status === "fail") {
      const meets = (f.value as number) >= (f.limit as number);
      f.status = meets ? "pass" : "fail";
      f.gap = round((f.value as number) - (f.limit as number));
    }
    findings.push(f);
  }
  if (input.constraints && input.constraints.reasons.length > 0) {
    findings.push(requirement({ id: "re.constraint_evidence", section: "5.3.5.1", metric: "Evidence of constrained and unconstrained areas", met: input.constraints.evidence ? true : null, reason: input.constraints.evidence ? `Evidence recorded: ${input.constraints.evidence}.` : "A reduced target needs evidence showing which areas within the curtilage are constrained; rooftop plant, green roofs and amenity space do not qualify on their own (5.3.5.1 note 2)." }));
  }
  return aspectResult("onsite_renewables", "5.3", "On-site renewable electricity generation", findings, warnings);
}
