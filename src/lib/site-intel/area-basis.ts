/**
 * Floor-area measurement bases.
 *
 * Kept in its own module with no imports because the client bundle needs the
 * labels. Importing them from voa.ts drags in sources.ts, which reads YAML from
 * disk, and Turbopack rightly refuses to put node:fs in the browser.
 *
 * These are not interchangeable. NIA excludes circulation and plant; GEA
 * includes external wall thickness. An energy intensity in kWh/m² changes
 * materially depending on which one is the denominator, so the basis always
 * travels with the number.
 */

export type AreaBasis = "GIA" | "NIA" | "GEA" | "EFA" | "unknown";

export const AREA_BASIS_LABEL: Record<AreaBasis, string> = {
  GIA: "Gross internal area",
  NIA: "Net internal area",
  GEA: "Gross external area",
  EFA: "Effective floor area",
  unknown: "Basis not stated",
};
