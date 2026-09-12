/**
 * Unit handling for activity lines.
 *
 * Only conversions that are exact and unambiguous are allowed. Anything else,
 * such as litres of fuel against a per-kilometre factor, is refused so the
 * portal never invents a conversion the user did not ask for.
 */
export const UNIT_CONVERSIONS: Record<string, Record<string, number>> = {
  miles: { km: 1.609344 },
  km: { miles: 0.621371192 },
  "passenger.miles": { "passenger.km": 1.609344 },
  "passenger.km": { "passenger.miles": 0.621371192 },
  "tonne.miles": { "tonne.km": 1.609344 },
  "tonne.km": { "tonne.miles": 0.621371192 },
  tonnes: { kg: 1000 },
  kg: { tonnes: 0.001 },
  m3: { litres: 1000 },
  litres: { m3: 0.001 },
};

const ALIASES: Record<string, string> = {
  mile: "miles",
  mi: "miles",
  kilometre: "km",
  kilometres: "km",
  kilometer: "km",
  kilometers: "km",
  passengerkm: "passenger.km",
  passengerkms: "passenger.km",
  tonnekm: "tonne.km",
  tonnekms: "tonne.km",
  tonne: "tonnes",
  t: "tonnes",
  kilogram: "kg",
  kilograms: "kg",
  kgs: "kg",
  litre: "litres",
  litre_s: "litres",
  l: "litres",
  "m^3": "m3",
  "m³": "m3",
  cubicmetres: "m3",
  cubicmeters: "m3",
};

export function normaliseUnit(unit: string): string {
  const base = unit.trim().toLowerCase().replace(/\s+/g, "");
  return ALIASES[base] ?? base;
}

/** Conversion from `from` to `to`: 1 when identical, null when unrelated. */
export function unitConversion(from: string, to: string): number | null {
  const a = normaliseUnit(from);
  const b = normaliseUnit(to);
  if (a === b) return 1;
  return UNIT_CONVERSIONS[a]?.[b] ?? null;
}
