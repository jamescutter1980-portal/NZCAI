import { DHCN_ASHP_SCOP, DHCN_CHILLER_SEER, DHCN_FOSSIL_FREE_YEAR, DHCN_PARASITIC_ENERGY, DHCN_PRIMARY_DISTRIBUTION_LOSSES } from "../constants";
import { aspectResult, compare, notApplicable, reported, requirement, round } from "../findings";
import type { AspectResult, DistrictNetwork, DistrictNetworkInput, Finding } from "../types";

/**
 * 5.7 District heating and cooling networks: the building's share of the
 * network's energy (Equation 2a), the carbon content of the heat or coolth
 * supplied (Equation 2b) and the year's limit (Equations 6a, 6b, 7a, 7b).
 */

/** Equation 2a. */
export function networkEnergyUse(n: DistrictNetwork): number | null {
  if (n.systemDeliveredKwh <= 0) return null;
  return round((n.generationInputKwh + n.distributionInputKwh) * (n.meteredKwh / n.systemDeliveredKwh));
}

/** Equation 2b, with recovered heat at zero (5.7.3.3). */
export function networkCarbonFactor(n: DistrictNetwork): number | null {
  if (n.systemDeliveredKwh <= 0) return null;
  const generation = Math.max(0, n.generationKgCo2e - (n.recoveredHeatKgCo2e ?? 0));
  return round((generation + n.distributionKgCo2e) / n.systemDeliveredKwh, 4);
}

/** Equations 6a, 6b, 7a and 7b. */
export function networkLimit(service: "heating" | "cooling", existing: boolean, gridFactor: number): { value: number; equation: string; working: string } {
  if (service === "cooling") {
    const value = round((1 / DHCN_CHILLER_SEER) * gridFactor, 4);
    return { value, equation: existing ? "6b" : "7b", working: `(1 / ${DHCN_CHILLER_SEER}) x ${gridFactor} = ${value}` };
  }
  if (existing) {
    const value = round(((1 + DHCN_PRIMARY_DISTRIBUTION_LOSSES) / DHCN_ASHP_SCOP + (1 + DHCN_PRIMARY_DISTRIBUTION_LOSSES) * DHCN_PARASITIC_ENERGY) * gridFactor, 4);
    return { value, equation: "6a", working: `[((1 + ${DHCN_PRIMARY_DISTRIBUTION_LOSSES}) / ${DHCN_ASHP_SCOP}) + ((1 + ${DHCN_PRIMARY_DISTRIBUTION_LOSSES}) x ${DHCN_PARASITIC_ENERGY})] x ${gridFactor} = ${value}` };
  }
  const value = round((1 / DHCN_ASHP_SCOP) * gridFactor, 4);
  return { value, equation: "7a", working: `(1 / ${DHCN_ASHP_SCOP}) x ${gridFactor} = ${value}` };
}

export function assessDistrictNetworks(input: DistrictNetworkInput | undefined, rpep: string): AspectResult {
  const findings: Finding[] = [];
  const warnings: string[] = [];
  if (!input || input.networks.length === 0) {
    findings.push(notApplicable({ id: "dh.scope", section: "5.7.1.1", metric: "District heating and cooling networks", reason: "The building is not recorded as connected to a district heating or cooling network." }));
    return aspectResult("district_networks", "5.7", "District heating and cooling networks", findings, warnings);
  }
  for (const n of input.networks) {
    const key = n.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const factor = networkCarbonFactor(n);
    const limit = networkLimit(n.service, n.existing, input.gridFactorKgCo2ePerKwh);
    findings.push(
      compare({
        id: `dh.${key}.carbon_content`,
        section: n.existing ? "5.7.6.2" : "5.7.6.3",
        metric: `${n.name}: carbon content of ${n.service === "heating" ? "heat" : "coolth"} supplied`,
        value: factor,
        limit: limit.value,
        unit: "kgCO2e/kWh",
        reason: `Equation 2b: (${n.generationKgCo2e}${n.recoveredHeatKgCo2e ? ` - ${n.recoveredHeatKgCo2e} recovered` : ""} + ${n.distributionKgCo2e}) / ${n.systemDeliveredKwh} = ${factor}. Limit by Equation ${limit.equation} for an ${n.existing ? "existing" : "new"} network: ${limit.working}, using the 5.2.3.4 grid factor ${input.gridFactorKgCo2ePerKwh}. The limit applies to the whole network with no sleeving (5.7.6.1 note 2).`,
        missingValue: "The network's delivered energy and carbon for the ORP are needed (5.7.5).",
      }),
    );
    findings.push(reported({ id: `dh.${key}.energy_use`, section: "5.2.3.6", metric: `${n.name}: energy used by the network for this building`, value: networkEnergyUse(n), unit: "kWh/yr", reason: `Equation 2a: (${n.generationInputKwh} + ${n.distributionInputKwh}) x (${n.meteredKwh} / ${n.systemDeliveredKwh}). Counts in the building's operational energy (5.2.3.1).` }));
    findings.push(reported({ id: `dh.${key}.carbon`, section: "5.7.2", metric: `${n.name}: carbon emissions associated with ${n.service === "heating" ? "heat" : "coolth"} supplied`, value: factor === null ? null : round(factor * n.meteredKwh), unit: "kgCO2e/yr", reason: `${n.meteredKwh} kWh metered at the connection x ${factor}.` }));
    if (n.suppliesFossilHeat) {
      if (n.existing) {
        const beyond = Number(rpep.slice(0, 4)) >= DHCN_FOSSIL_FREE_YEAR;
        findings.push(requirement({ id: `dh.${key}.fossil_plan`, section: "5.7.6.2", metric: `${n.name}: plan to end fossil fuel use by ${DHCN_FOSSIL_FREE_YEAR}`, met: beyond ? false : (n.decarbonisationPlanInPlace ?? null), reason: beyond ? `From 1 January ${DHCN_FOSSIL_FREE_YEAR} heat from an existing network may not come from fossil fuels.` : n.decarbonisationPlanInPlace ? "A published plan is in place; the 5.7.5 details (statement, plant, calculations, business model) are submission items." : "An existing network still using fossil fuels needs a published plan to stop by 2040 (5.7.5, 5.7.6.2)." }));
      } else {
        findings.push(requirement({ id: `dh.${key}.fossil_free`, section: "5.7.6.3", metric: `${n.name}: no fossil heat from a new network`, met: false, reason: "Heat or coolth from a new network shall not come from fossil fuels." }));
      }
    }
  }
  return aspectResult("district_networks", "5.7", "District heating and cooling networks", findings, warnings);
}
