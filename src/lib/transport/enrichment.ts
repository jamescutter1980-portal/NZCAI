import { defaultContext, type OperationContext, type OperationResult } from "@/lib/integrations/framework";
import { NotConfiguredError, runSourceOperation } from "@/lib/integrations/service";
import type { Provenance } from "@/lib/provenance";

/**
 * Vehicle enrichment for fleet and grey-fleet carbon work.
 *
 * Looks one UK registration up against the DVLA Vehicle Enquiry Service
 * (register facts) and the DVSA MOT History API (odometer readings), and
 * returns the fields a carbon calculation needs plus the caveats that stop
 * those fields being misused.
 *
 * Two things this module deliberately refuses to do:
 *
 *  1. It never converts anything to CO2e. DVLA's `co2Emissions` is a
 *     type-approval figure from a laboratory cycle, not a real-world
 *     emission factor, and is carried through with a warning saying so.
 *  2. It never presents MOT odometer distance as business mileage. The MOT
 *     record cannot separate business from private use, so the derived
 *     annual mileage is an upper bound on grey-fleet business mileage only.
 *
 * One source failing does not fail the enrichment: each source is recorded
 * in `sources` with ok/detail, the message goes into `warnings`, and
 * whatever the other source returned is still returned.
 */

export const DVLA_SOURCE_ID = "dvla-ves";
export const MOT_SOURCE_ID = "dvsa-mot-history";

/** DVLA `lookup` and DVSA `history` both take a `registration` parameter. */
export const DVLA_OPERATION_ID = "lookup";
export const MOT_OPERATION_ID = "history";

/** 1 km = 0.621371 miles (international mile, exact value 1/1.609344). */
export const KM_TO_MILES = 0.621371;

const DAYS_PER_YEAR = 365.25;

/** The shortest MOT-to-MOT interval worth annualising; below this, rounding dominates. */
const MIN_SPAN_DAYS = 30;

export const CO2_TYPE_APPROVAL_WARNING =
  "The CO2 figure is DVLA's type-approval value (NEDC or WLTP depending on the vehicle's age), measured on a laboratory test cycle for vehicle taxation. It is not a real-world emission factor and must not be used in place of a DESNZ/DEFRA conversion factor for carbon reporting. Real-world emissions are materially higher, and the gap varies by cycle, powertrain and duty. Use it to classify or compare vehicles, not to calculate a reportable footprint.";

export const MILEAGE_USE_CAVEAT =
  "MOT odometer distance cannot distinguish business from private use, so it is an upper bound for grey-fleet business mileage and never the business figure itself; obtain the business split from expense claims, a mileage log or telematics.";

export interface VehicleFacts {
  make?: string;
  model?: string;
  fuelType?: string;
  engineCapacityCc?: number;
  co2GPerKm?: number;
  yearOfManufacture?: number;
  monthOfFirstRegistration?: string;
  euroStatus?: string;
  typeApproval?: string;
  taxStatus?: string;
  motStatus?: string;
  motExpiryDate?: string;
}

export interface OdometerReading {
  date: string;
  value: number;
  unit: "mi" | "km";
  resultType?: string;
}

export interface MileageEstimate {
  readings: OdometerReading[];
  /** Miles per year from the two most useful consecutive readings, or null. */
  annualMileageMiles: number | null;
  spanDays: number | null;
  detail: string;
}

export interface EnrichmentResult {
  registration: string;
  facts: VehicleFacts;
  mileage: MileageEstimate | null;
  sources: { id: string; ok: boolean; detail: string }[];
  provenance: Provenance[];
  warnings: string[];
}

/**
 * Normalises a UK vehicle registration mark: whitespace stripped, uppercased,
 * 2 to 8 alphanumeric characters.
 *
 * @throws RangeError if the input is not a plausible VRM.
 */
export function normaliseVrm(raw: string): string {
  if (typeof raw !== "string") throw new RangeError("Registration must be a string");
  const vrm = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(vrm)) {
    throw new RangeError(`"${raw}" is not a valid UK vehicle registration: expected 2 to 8 letters and digits, spaces optional.`);
  }
  return vrm;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value === "string") {
    const t = value.trim();
    return t ? t : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const n = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Message for a failed source, unwrapping the framework's error types. */
function failureDetail(sourceLabel: string, error: unknown): string {
  if (error instanceof NotConfiguredError) {
    return `${sourceLabel} is not configured: set ${error.missing.join(", ")}. No lookup was attempted.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `${sourceLabel} lookup failed: ${message}`;
}

/** Maps a DVLA `lookup` row onto VehicleFacts. */
function factsFromDvlaRow(row: Record<string, unknown>): VehicleFacts {
  const facts: VehicleFacts = {};
  const assign = <K extends keyof VehicleFacts>(key: K, value: VehicleFacts[K]) => {
    if (value !== undefined && value !== null) facts[key] = value;
  };
  assign("make", str(row.make));
  assign("fuelType", str(row.fuel_type));
  assign("engineCapacityCc", num(row.engine_cc));
  assign("co2GPerKm", num(row.co2_g_km));
  assign("yearOfManufacture", num(row.year_of_manufacture));
  assign("monthOfFirstRegistration", str(row.first_registered));
  assign("euroStatus", str(row.euro_status));
  assign("typeApproval", str(row.type_approval));
  assign("taxStatus", str(row.tax_status));
  assign("motStatus", str(row.mot_status));
  assign("motExpiryDate", str(row.mot_expiry));
  return facts;
}

/** Odometer readings from the DVSA `history` rows, in the units the tester recorded. */
export function readingsFromMotRows(rows: Record<string, unknown>[]): { readings: OdometerReading[]; skipped: number } {
  const readings: OdometerReading[] = [];
  let skipped = 0;
  for (const row of rows) {
    const date = str(row.test_date)?.slice(0, 10);
    const value = num(row.odometer);
    const resultType = str(row.odometer_type);
    // The connector exposes odometer_type; anything other than READ (NO_ODOMETER,
    // NOT_READABLE, ...) is not a genuine reading and is dropped.
    if (resultType && resultType.toUpperCase() !== "READ") {
      skipped += 1;
      continue;
    }
    if (!date || value === undefined || value <= 0) {
      skipped += 1;
      continue;
    }
    const unit: "mi" | "km" = (str(row.odometer_unit) ?? "MI").toUpperCase().startsWith("K") ? "km" : "mi";
    readings.push({ date, value, unit, ...(resultType ? { resultType } : {}) });
  }
  readings.sort((a, b) => a.date.localeCompare(b.date));
  return { readings, skipped };
}

function toMiles(reading: OdometerReading): number {
  return reading.unit === "km" ? reading.value * KM_TO_MILES : reading.value;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/**
 * Derives an annual mileage from sorted odometer readings.
 *
 * Readings that do not increase on the previous one (a replaced instrument, a
 * unit change, a transcription error or clocking) break the series: the run is
 * cut there and a new one started. The longest clean run by elapsed days is
 * then annualised.
 */
export function estimateAnnualMileage(readings: OdometerReading[], warnings: string[]): { annualMileageMiles: number | null; spanDays: number | null; detail: string } {
  if (readings.length === 0) {
    return { annualMileageMiles: null, spanDays: null, detail: `No usable MOT odometer readings, so no annual mileage could be derived. ${MILEAGE_USE_CAVEAT}` };
  }
  if (readings.some((r) => r.unit === "km")) {
    warnings.push(`Some MOT odometer readings were recorded in kilometres and have been converted to miles at 1 km = ${KM_TO_MILES} mi before any comparison.`);
  }
  if (readings.length === 1) {
    return {
      annualMileageMiles: null,
      spanDays: null,
      detail: `Only one usable MOT odometer reading (${Math.round(toMiles(readings[0])).toLocaleString("en-GB")} miles on ${readings[0].date}), so no rate of use could be derived. ${MILEAGE_USE_CAVEAT}`,
    };
  }

  // Split into maximal runs of strictly increasing readings.
  const runs: OdometerReading[][] = [[readings[0]]];
  for (let i = 1; i < readings.length; i++) {
    const previous = readings[i - 1];
    const current = readings[i];
    if (toMiles(current) > toMiles(previous)) {
      runs[runs.length - 1].push(current);
      continue;
    }
    warnings.push(
      `MOT odometer reading of ${Math.round(toMiles(current)).toLocaleString("en-GB")} miles on ${current.date} is not higher than the ${Math.round(toMiles(previous)).toLocaleString("en-GB")} miles recorded on ${previous.date}. A replaced instrument, a unit change or a recording error is likely; the series was cut at this point and the reading excluded from the estimate.`,
    );
    runs.push([current]);
  }

  let best: { run: OdometerReading[]; spanDays: number } | undefined;
  for (const run of runs) {
    if (run.length < 2) continue;
    const spanDays = daysBetween(run[0].date, run[run.length - 1].date);
    if (spanDays < MIN_SPAN_DAYS) continue;
    if (!best || spanDays > best.spanDays) best = { run, spanDays };
  }

  if (!best) {
    return {
      annualMileageMiles: null,
      spanDays: null,
      detail: `No clean run of increasing MOT odometer readings at least ${MIN_SPAN_DAYS} days apart, so no annual mileage could be derived. ${MILEAGE_USE_CAVEAT}`,
    };
  }

  const first = best.run[0];
  const last = best.run[best.run.length - 1];
  const miles = toMiles(last) - toMiles(first);
  const annualMileageMiles = Math.round((miles / best.spanDays) * DAYS_PER_YEAR);
  const unitNote = best.run.some((r) => r.unit === "km") ? ` Readings recorded in kilometres were converted at 1 km = ${KM_TO_MILES} mi.` : "";
  const detail =
    `${annualMileageMiles.toLocaleString("en-GB")} miles per year, from ${Math.round(miles).toLocaleString("en-GB")} miles between MOT odometer readings on ${first.date} and ${last.date} (${best.spanDays} days, ${best.run.length} readings).${unitNote}` +
    ` This is total distance travelled by the vehicle. ${MILEAGE_USE_CAVEAT}`;
  return { annualMileageMiles, spanDays: best.spanDays, detail };
}

/** Narrows the DVSA `history` raw payload for the make/model/fuel it carries. */
function factsFromMotRaw(raw: unknown): VehicleFacts {
  const record = asRecord(raw);
  if (!record) return {};
  const facts: VehicleFacts = {};
  const make = str(record.make);
  const model = str(record.model);
  const fuelType = str(record.fuelType);
  if (make) facts.make = make;
  if (model) facts.model = model;
  if (fuelType) facts.fuelType = fuelType;
  return facts;
}

/** Later values only fill gaps; the register (DVLA) wins where both have a value. */
function mergeFacts(primary: VehicleFacts, secondary: VehicleFacts): VehicleFacts {
  const merged: VehicleFacts = { ...secondary };
  for (const [key, value] of Object.entries(primary)) {
    if (value !== undefined && value !== null) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

async function tryOperation(
  sourceId: string,
  operationId: string,
  registration: string,
  ctx: OperationContext,
): Promise<{ ok: true; result: OperationResult } | { ok: false; error: unknown }> {
  try {
    return { ok: true, result: await runSourceOperation(sourceId, operationId, { registration }, ctx) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Looks a registration up against DVLA and (unless `includeMot` is false) DVSA
 * and returns the merged vehicle facts, an annual mileage estimate, per-source
 * status, provenance and the warnings a user must read before using either.
 *
 * @throws RangeError if the registration is not a plausible UK VRM. This is the
 * only way this function throws; every source failure is reported in the result.
 */
export async function enrichVehicle(registration: string, ctx?: OperationContext, opts?: { includeMot?: boolean }): Promise<EnrichmentResult> {
  const vrm = normaliseVrm(registration);
  const context = ctx ?? defaultContext();
  const includeMot = opts?.includeMot !== false;

  const sources: EnrichmentResult["sources"] = [];
  const provenance: Provenance[] = [];
  const warnings: string[] = [];

  const [dvla, mot] = await Promise.all([
    tryOperation(DVLA_SOURCE_ID, DVLA_OPERATION_ID, vrm, context),
    includeMot ? tryOperation(MOT_SOURCE_ID, MOT_OPERATION_ID, vrm, context) : Promise.resolve(undefined),
  ]);

  // --- DVLA Vehicle Enquiry Service: register facts ---
  let dvlaFacts: VehicleFacts = {};
  if (dvla.ok) {
    const row = asRecord(dvla.result.rows?.[0]);
    if (row) {
      dvlaFacts = factsFromDvlaRow(row);
      sources.push({ id: DVLA_SOURCE_ID, ok: true, detail: dvla.result.summary });
    } else {
      // The connector accepts 400/404 and returns no rows rather than throwing.
      sources.push({ id: DVLA_SOURCE_ID, ok: false, detail: dvla.result.summary });
      warnings.push(`DVLA has no vehicle record for ${vrm}: ${dvla.result.summary}`);
    }
    provenance.push(dvla.result.provenance);
    for (const w of dvla.result.warnings ?? []) warnings.push(w);
  } else {
    const detail = failureDetail("DVLA Vehicle Enquiry Service", dvla.error);
    sources.push({ id: DVLA_SOURCE_ID, ok: false, detail });
    warnings.push(detail);
  }

  // --- DVSA MOT History: odometer readings ---
  let motFacts: VehicleFacts = {};
  let mileage: MileageEstimate | null = null;
  if (!includeMot) {
    sources.push({ id: MOT_SOURCE_ID, ok: false, detail: "MOT history not requested (includeMot false); no mileage was derived." });
  } else if (mot?.ok) {
    motFacts = factsFromMotRaw(mot.result.raw);
    const rows = (mot.result.rows ?? []) as Record<string, unknown>[];
    const { readings, skipped } = readingsFromMotRows(rows);
    const mileageWarnings: string[] = [];
    if (skipped > 0) {
      mileageWarnings.push(`${skipped} MOT test${skipped === 1 ? "" : "s"} had no genuine odometer reading (result type not READ, or no value recorded) and ${skipped === 1 ? "was" : "were"} excluded.`);
    }
    const estimate = estimateAnnualMileage(readings, mileageWarnings);
    mileage = { readings, ...estimate };
    warnings.push(...mileageWarnings);
    warnings.push(MILEAGE_USE_CAVEAT);
    sources.push({ id: MOT_SOURCE_ID, ok: true, detail: mot.result.summary });
    provenance.push({
      ...mot.result.provenance,
      dataset: `${mot.result.provenance.dataset} (odometer)`,
      basis: estimate.annualMileageMiles !== null ? "estimated" : readings.length > 0 ? "measured" : "unavailable",
    });
    for (const w of mot.result.warnings ?? []) warnings.push(w);
  } else if (mot) {
    const detail = failureDetail("DVSA MOT History", mot.error);
    sources.push({ id: MOT_SOURCE_ID, ok: false, detail });
    warnings.push(detail);
  }

  const facts = mergeFacts(dvlaFacts, motFacts);
  if (facts.co2GPerKm !== undefined) warnings.push(CO2_TYPE_APPROVAL_WARNING);

  if (sources.every((s) => !s.ok)) {
    warnings.push(`No source returned a record for ${vrm}; every field below is empty. Do not treat this as "vehicle has no emissions".`);
  }

  return { registration: vrm, facts, mileage, sources, provenance, warnings };
}
