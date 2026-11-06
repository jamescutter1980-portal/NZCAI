import { aspectResult, compare, notApplicable, reported, round } from "../findings";
import type { LimitContext } from "../limits";
import type { AspectResult, BuildingProfile, Finding } from "../types";

/**
 * 5.1 Embodied carbon: the portal cannot perform a whole life carbon
 * assessment. It imports the results per programme of works and compares the
 * upfront carbon with the Table EC-1 to EC-3 limit selected for that works,
 * plus the PV limit of Table EC-5.
 */
export function assessEmbodiedCarbon(profile: BuildingProfile, ctx: LimitContext): AspectResult {
  const findings: Finding[] = [];
  const warnings: string[] = [];
  const works = (profile.works ?? []).filter((w) => ctx.embodied.some((e) => e.worksId === w.id));
  if (works.length === 0) {
    findings.push(notApplicable({ id: "ec.scope", section: "5.1.2.1", metric: "Embodied carbon", reason: `No New, Retrofit or Reportable Works completed within the ERP (${ctx.periods.erp.from} to ${ctx.periods.erp.to}), so no embodied carbon assessment is required (4.2.1.1).` }));
    return aspectResult("embodied_carbon", "5.1", "Embodied carbon", findings, warnings);
  }
  for (const w of works) {
    const sel = ctx.embodied.find((e) => e.worksId === w.id)!;
    const e = w.embodied;
    const gia = e?.giaM2 ?? null;
    let upfront = e?.upfrontKgCo2e ?? null;
    if (sel.reportableScope === "Cat B" && e?.upfrontCatBKgCo2e !== undefined) upfront = e.upfrontCatBKgCo2e;
    const perM2 = upfront !== null && gia && gia > 0 ? round(upfront / gia) : null;
    const label = `${w.id} (${sel.worksType}, commenced ${w.commencementDate})`;
    if (sel.worksType === "Non-Reportable Works") {
      findings.push(notApplicable({ id: `ec.${w.id}.upfront`, section: "5.1.2.1", metric: `${label}: upfront carbon`, reason: "Non-Reportable Works are outside the embodied carbon scope." }));
      continue;
    }
    if (!sel.compare) {
      findings.push(reported({ id: `ec.${w.id}.upfront`, section: "5.1.6", metric: `${label}: upfront carbon`, value: perM2, unit: "kgCO2e/m2GIA", reason: sel.notes.join(" ") || "Assessed and reported; not compared with a limit.", basis: "Imported RICS PS assessment." }));
      continue;
    }
    findings.push(
      compare({
        id: `ec.${w.id}.upfront`,
        section: sel.table === "EC-3" ? "5.1.6.2" : "5.1.6.1",
        metric: `${label}: upfront carbon${sel.reportableScope ? ` (${sel.reportableScope})` : ""}`,
        value: perM2,
        limit: sel.status === "limit" ? sel.value : null,
        unit: "kgCO2e/m2GIA",
        reason: `${upfront} kgCO2e over ${gia} m2 GIA against Table ${sel.table} for ${sel.year}${sel.method === "equation_1a" ? " (Equation 1a)" : ""}. ${sel.notes.join(" ")}`,
        basis: "Imported RICS PS whole life carbon assessment; material quantities, factor sources and uncertainty are submission items (5.1.5).",
        missingValue: upfront === null ? "No upfront carbon figure imported for these works." : "No GIA recorded for the works.",
        missingLimit: sel.status === "no_limit" ? `No limit in Table ${sel.table} for this sector. ${sel.notes.join(" ")}` : sel.notes.join(" "),
      }),
    );
    if (e?.lifeCycleKgCo2ePerM2 !== undefined) findings.push(reported({ id: `ec.${w.id}.life_cycle`, section: "5.1.6.3", metric: `${label}: life cycle embodied carbon`, value: e.lifeCycleKgCo2ePerM2, unit: "kgCO2e/m2GIA", reason: "No life cycle limit in this version; reported." }));
    if (e?.genericSpecificationKgCo2ePerM2 !== undefined) findings.push(reported({ id: `ec.${w.id}.generic`, section: "5.1.2.6", metric: `${label}: upfront carbon with generic material specifications`, value: e.genericSpecificationKgCo2ePerM2, unit: "kgCO2e/m2GIA", reason: "Reporting metric (Table 8)." }));
    if (e?.pvKwp !== undefined && e.pvKwp > 0) {
      const perKwp = e.pvUpfrontKgCo2e !== undefined ? round(e.pvUpfrontKgCo2e / e.pvKwp) : null;
      findings.push(compare({ id: `ec.${w.id}.pv`, section: "5.1.6.4", metric: `${label}: PV upfront carbon per kWp`, value: perKwp, limit: ctx.pvUpfront.value, unit: ctx.pvUpfront.unit, reason: `${e.pvUpfrontKgCo2e} kgCO2e over ${e.pvKwp} kWp against Table EC-5. ${ctx.pvUpfront.notes.join(" ")}`, missingValue: "No upfront carbon figure for the PV system.", missingLimit: "No PV limit loaded." }));
    }
  }
  return aspectResult("embodied_carbon", "5.1", "Embodied carbon", findings, warnings);
}
