import { SPACE_HEATING_EXISTING_FROM_YEAR } from "../constants";
import { aspectResult, compare, notApplicable, reported, round } from "../findings";
import type { LimitContext } from "../limits";
import type { AspectResult, BuildingProfile, Finding, SpaceHeatingInput } from "../types";

/**
 * 5.8 Space heating and cooling delivered to the building: measured for New
 * Buildings, and for Existing Buildings from an RPEP in 2040 or where heat
 * meters exist; limited (Table OE-4) for Homes and Commercial Residential in
 * New Buildings only.
 */
export function assessSpaceHeating(profile: BuildingProfile, ctx: LimitContext, input: SpaceHeatingInput | undefined): AspectResult {
  const findings: Finding[] = [];
  const warnings: string[] = [...ctx.spaceHeating.notes];
  const isNew = ctx.buildingType.value === "New Building";
  const rpepYear = Number(profile.rpep.slice(0, 4));
  const required = isNew || rpepYear >= SPACE_HEATING_EXISTING_FROM_YEAR || !!input?.heatMetersInstalled;
  if (!required) {
    findings.push(notApplicable({ id: "sh.scope", section: "5.8.1.1", metric: "Heating and cooling delivered to the building", reason: `Existing Building with an RPEP before ${SPACE_HEATING_EXISTING_FROM_YEAR} and no heat meters installed: not required in this version.`, kind: "reporting" }));
    return aspectResult("space_heating_cooling", "5.8", "Space heating and cooling delivered to the building", findings, warnings);
  }
  const area = input?.occupiedGiaM2 ?? null;
  const heating = input?.heatingDeliveredKwh ?? null;
  const cooling = input?.coolingDeliveredKwh ?? null;
  const perM2 = (kwh: number | null) => (kwh !== null && area && area > 0 ? round(kwh / area) : null);
  const basis = input?.vrfCalculated ? "VRF delivery calculated from submetered electricity, system efficiency and the heating/cooling split (5.8.3); calculations are a submission item." : "Heat and coolth meter readings (5.8.1.1).";
  const limit = ctx.spaceHeating;
  if (limit.status === "limit") {
    findings.push(compare({ id: "sh.heating_limit", section: "5.8.5.2", metric: "Annual space heating delivered to the building", value: perM2(heating), limit: limit.value, unit: "kWh/m2GIA/yr", reason: `${heating} kWh over ${area} m2 occupied GIA against Table OE-4 for ${limit.year}.`, basis, missingValue: heating === null ? "No delivered heating figure for the ORP." : "No occupied GIA to normalise against (Table 18 note a)." }));
  } else {
    findings.push(reported({ id: "sh.heating", section: "5.8.2", metric: "Annual space heating delivered to the building", value: perM2(heating), unit: "kWh/m2GIA/yr", reason: heating === null ? "No delivered heating figure for the ORP." : limit.notes[0] ?? "", basis }));
  }
  findings.push(reported({ id: "sh.cooling", section: "5.8.2", metric: "Annual space cooling delivered to the building", value: perM2(cooling), unit: "kWh/m2GIA/yr", reason: cooling === null ? "No delivered cooling figure for the ORP." : "", basis }));
  findings.push(reported({ id: "sh.peak_heating", section: "5.8.2", metric: "Peak energy delivered for space heating", value: input?.peakHeatingKw !== undefined && area ? round((input.peakHeatingKw * 1000) / area, 1) : null, unit: "W/m2GIA", reason: input?.peakHeatingKw === undefined ? "No peak heating figure." : "" }));
  findings.push(reported({ id: "sh.peak_cooling", section: "5.8.2", metric: "Peak energy delivered for space cooling", value: input?.peakCoolingKw !== undefined && area ? round((input.peakCoolingKw * 1000) / area, 1) : null, unit: "W/m2GIA", reason: input?.peakCoolingKw === undefined ? "No peak cooling figure." : "" }));
  if (ctx.sectors.classification === "Data Centres") warnings.push("Data Centres have no limit, but all heat demand shall be met by heat re-use within the data centre (5.8.5.1).");
  return aspectResult("space_heating_cooling", "5.8", "Space heating and cooling delivered to the building", findings, warnings);
}
