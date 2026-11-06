import { assessDemand } from "./aspects/demand";
import { assessDistrictNetworks } from "./aspects/district-networks";
import { assessEmbodiedCarbon } from "./aspects/embodied-carbon";
import { assessFossilFuelFree } from "./aspects/fossil-fuel-free";
import { assessOffsets } from "./aspects/offsets";
import { assessOperationalEnergy } from "./aspects/operational-energy";
import { assessRefrigerants } from "./aspects/refrigerants";
import { assessRenewables } from "./aspects/renewables";
import { assessSpaceHeating } from "./aspects/space-heating";
import { assessWater } from "./aspects/water";
import { STANDARD_NAME } from "./constants";
import { aspectResult, overall, requirement } from "./findings";
import { preVerificationStatement } from "./language";
import { resolveLimits, type LimitContext } from "./limits";
import { referenceLabel, type NzcbsReference } from "./reference";
import type { AspectResult, BuildingProfile, Finding, FindingStatus, OperationalInputs } from "./types";

/**
 * UK NZCBS V1 Rev 1 rule engine: one call that classifies the building,
 * selects its limits and assesses every aspect of section 5 from the figures
 * supplied. Pure: the caller loads the reference tables and gathers the
 * inputs; nothing here reads a file or a database.
 *
 * The governing rule, unchanged from the portal's earlier indicative check:
 * no limit, benchmark or building value is invented. Where the Standard sets
 * no limit the finding says so; where the inputs cannot give a value the
 * finding is not assessable with the reason; neither is ever a pass.
 */

export * from "./types";
export * from "./constants";
export * from "./classify";
export * from "./limits";
export * from "./language";
export * from "./findings";
export { assessOperationalEnergy, energyBreakdown, gridFactor, occupancyRate, euiDenominatorGia } from "./aspects/operational-energy";
export { assessRenewables } from "./aspects/renewables";
export { assessWater } from "./aspects/water";
export { assessFossilFuelFree, systemVerdict } from "./aspects/fossil-fuel-free";
export { assessDemand, demandStatistics, percentileInclusive } from "./aspects/demand";
export { assessDistrictNetworks, networkCarbonFactor, networkEnergyUse, networkLimit } from "./aspects/district-networks";
export { assessSpaceHeating } from "./aspects/space-heating";
export { assessRefrigerants, gwpException, leakageKg } from "./aspects/refrigerants";
export { assessOffsets } from "./aspects/offsets";
export { assessEmbodiedCarbon } from "./aspects/embodied-carbon";
export {
  INTEGRATION_ID as NZCBS_INTEGRATION_ID,
  bundledReferenceDir,
  clearNzcbsReferenceCache,
  clampLimitYear,
  deploymentReferenceDir,
  findLimit,
  listReferenceVersions,
  loadNzcbsReference,
  otherLimit,
  referenceLabel,
  renewablesTarget,
  NzcbsReferenceError,
  type LimitQuery,
  type LimitResolution,
  type LimitRow,
  type LimitStatus,
  type NzcbsReference,
  type OtherLimit,
  type ReferenceManifest,
  type ReferenceVersion,
  type RenewablesTargetRow,
} from "./reference";

export interface BuildingAssessment {
  standard: string;
  reference: string;
  version: string;
  rpep: string;
  orp: { from: string; to: string };
  erp: { from: string; to: string };
  buildingType: string;
  classification: string;
  sectors: { sector: string; share: number }[];
  limitYear: number;
  limits: LimitContext;
  aspects: AspectResult[];
  /** Worst status across the pass-fail aspects. */
  status: FindingStatus;
  counts: Record<FindingStatus, number>;
  /** 7.4.1: the only statement permitted before verification. */
  permittedStatement: string;
  disclaimer: string;
  warnings: string[];
}

export const DISCLAIMER =
  `Pre-verification assessment against the ${STANDARD_NAME}. It is not a verified claim: conformity requires assessment of measured performance over a full Operational Reporting Period, submission through the Submission Proforma, and verification by an approved verifier through NZCBS Ltd (sections 4.3, 6 and 7). Until then the building may only be described as "${preVerificationStatement()}".`;

/** The classification itself is a submission item (4.2.7), so it is reported as an aspect. */
function classificationAspect(profile: BuildingProfile, ctx: LimitContext): AspectResult {
  const findings: Finding[] = [];
  findings.push(requirement({ id: "cl.can_claim", section: "4.2.2", metric: "Less than 30% of NIA unclassifiable", met: ctx.sectors.canClaim, reason: ctx.sectors.canClaim ? `${Math.round(ctx.sectors.unclassifiableShare * 1000) / 10}% of NIA is unclassifiable.` : ctx.sectors.reasons.find((r) => r.includes("unclassifiable")) ?? "" }));
  findings.push(requirement({ id: "cl.building_type", section: ctx.buildingType.section, metric: `Building type: ${ctx.buildingType.value}`, met: true, reason: ctx.buildingType.reasons.join(" ") }));
  findings.push(requirement({ id: "cl.sector", section: "4.2.2", metric: `Classification: ${ctx.sectors.classification}`, met: ctx.sectors.sectors.length > 0, reason: ctx.sectors.reasons.join(" ") }));
  for (const u of ctx.sectors.additionalUses) {
    findings.push(requirement({ id: `cl.additional_use.${u.label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, section: "5.2.1.3", metric: `Additional Use: ${u.label} (${u.niaM2} m2 NIA)`, met: u.allowed, reason: u.reason }));
  }
  findings.push(requirement({ id: "cl.limit_year", section: ctx.operationalLimitYear.section, metric: `Operational energy limit year: ${ctx.operationalLimitYear.year}`, met: true, reason: ctx.operationalLimitYear.rule }));
  if (!profile.footprintM2) findings.push(requirement({ id: "cl.footprint", section: "5.3.2", metric: "Building footprint recorded", met: null, reason: "The renewables target is per m2 of building footprint; none is recorded." }));
  if (!profile.region) findings.push(requirement({ id: "cl.region", section: "Annex A3", metric: "Annex A3 region recorded", met: null, reason: "The renewables target depends on the region; none is recorded." }));
  return aspectResult("classification", "4", "Classification and reporting periods", findings, [...ctx.periods.reasons]);
}

export function assessBuilding(ref: NzcbsReference, profile: BuildingProfile, inputs: OperationalInputs = {}): BuildingAssessment {
  const limits = resolveLimits(ref, profile, inputs.renewables);
  const aspects: AspectResult[] = [
    classificationAspect(profile, limits),
    assessEmbodiedCarbon(profile, limits),
    assessOperationalEnergy(profile, limits, inputs.energy),
    assessRenewables(profile, limits, inputs.renewables),
    assessWater(profile, limits, inputs.water),
    assessFossilFuelFree(inputs.fossilFuels ? { ...inputs.fossilFuels, supplies: inputs.fossilFuels.supplies ?? inputs.energy?.supplies } : inputs.energy ? { systems: [], supplies: inputs.energy.supplies } : undefined),
    assessDemand(inputs.demand),
    assessDistrictNetworks(inputs.districtNetworks, profile.rpep),
    assessSpaceHeating(profile, limits, inputs.spaceHeating),
    assessRefrigerants(limits, inputs.refrigerants, profile.rpep),
    assessOffsets(inputs.offsets, profile.rpep),
  ];
  const all = aspects.flatMap((a) => a.findings);
  const counts: Record<FindingStatus, number> = { pass: 0, fail: 0, reported: 0, not_assessable: 0, not_applicable: 0 };
  for (const f of all) counts[f.status]++;
  const status = overall(all);
  return {
    standard: `${STANDARD_NAME}, ${ref.manifest.standard.replace(/^.*?,\s*/, "")}`,
    reference: referenceLabel(ref),
    version: ref.version,
    rpep: profile.rpep,
    orp: limits.periods.orp,
    erp: limits.periods.erp,
    buildingType: limits.buildingType.value,
    classification: limits.sectors.classification,
    sectors: limits.sectors.sectors.map((s) => ({ sector: s.sector, share: s.share })),
    limitYear: limits.operationalLimitYear.year,
    limits,
    aspects,
    status,
    counts,
    permittedStatement: preVerificationStatement(),
    disclaimer: DISCLAIMER,
    warnings: [...new Set(aspects.flatMap((a) => a.warnings))],
  };
}
