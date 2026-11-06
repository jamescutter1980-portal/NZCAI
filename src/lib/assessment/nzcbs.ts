import type { Db } from "@/lib/db/sqlite";
import type { OperationContext } from "@/lib/integrations/framework";
import type { AssetMeter, AssetRecord } from "@/lib/assets/types";
import { assetCarbon } from "@/lib/carbon";
import { DESNZ_SELECTORS, desnzFactor } from "@/lib/carbon/factors";
import {
  assessBuilding,
  DISCLAIMER,
  loadNzcbsReference,
  listReferenceVersions,
  preVerificationStatement,
  SECTORS,
  STATUS_LABELS,
  type BuildingAssessment,
  type BuildingProfile,
  type EnergySupply,
  type Finding,
  type FindingStatus,
  type GridFactors,
  type OperationalInputs,
  type Sector,
} from "@/lib/nzcbs";
import { bundledReferenceDir, deploymentReferenceDir } from "@/lib/nzcbs/reference";
import { assetIntensity, carbonFactorReferences, type AssessmentProvenance, type AssetIntensity } from "./crrem";

/**
 * Pre-verification assessment of one asset against UK NZCBS V1 Rev 1.
 *
 * This adapter builds the engine's inputs from what the portal holds today:
 * one floor area, a property type, and metered electricity and gas. The
 * engine (src/lib/nzcbs) applies the Standard. Everything the portal cannot
 * yet supply (NIA, footprint, region, works, occupancy, generation, systems
 * registers) comes back not assessable with the reason, never as a pass.
 *
 * Not a verified assessment: the Standard's own metering, submission and
 * verification process applies (sections 4.3, 6 and 7).
 */

export const NZCBS_DISCLAIMER = DISCLAIMER;

export type NzcbsStatus = FindingStatus;

export interface NzcbsMetricRow {
  aspect: string;
  section: string;
  metric: string;
  limitValue: number | null;
  unit: string;
  year: number | null;
  assetValue: number | null;
  status: NzcbsStatus;
  /** Plain-English label for the status, in the Standard's permitted language. */
  label: string;
  gap: number | null;
  reason: string;
  notes: string;
}

export interface NzcbsAssessment {
  assessable: boolean;
  summary: string;
  reasons: string[];
  /** Reporting year (the ORP is that calendar year; the RPEP is its last day). */
  year: number;
  /** Year the operational energy limit was read for (5.2.7.1). */
  limitYear: number | null;
  sector: string | null;
  subsector: string | null;
  buildingType: string | null;
  version: string | null;
  rows: NzcbsMetricRow[];
  counts: { pass: number; fail: number; notAssessable: number; reported: number; notApplicable: number };
  intensity: AssetIntensity;
  provenance: AssessmentProvenance;
  disclaimer: string;
  permittedStatement: string;
  warnings: string[];
  /** The full engine result, for callers that need the structure. */
  assessment: BuildingAssessment | null;
}

export interface NzcbsOptions {
  year: number;
  /** Table 6 sector, optionally with subsector and scope: "Offices", "Offices / General", "Offices / General / Whole building". Defaults to a mapping of the asset's property type. */
  sector?: string;
  /** Reference version folder, e.g. "v1r1". Defaults to the newest loaded. */
  version?: string;
}

/* ------------------------------------------------------------------ */
/* sector mapping                                                      */
/* ------------------------------------------------------------------ */

export interface SectorMapping {
  sector: Sector;
  subsector?: string;
  scope?: string;
  note: string;
}

const SYNONYMS: { test: RegExp; sector: Sector; subsector?: string; scope?: string }[] = [
  { test: /trading floor/i, sector: "Offices", subsector: "Trading floors", scope: "Whole building" },
  { test: /call cent/i, sector: "Offices", subsector: "Call Centres", scope: "Whole building" },
  { test: /\boffice/i, sector: "Offices", subsector: "General", scope: "Whole building" },
  { test: /supermarket/i, sector: "Retail", subsector: "Supermarket" },
  { test: /retail warehouse/i, sector: "Retail", subsector: "Retail Warehouse" },
  { test: /restaurant|pub\b|cafe|café|food/i, sector: "Retail", subsector: "Food & beverage - with commercial kitchen" },
  { test: /shopping centre|landlord area/i, sector: "Retail", subsector: "Landlord Areas" },
  { test: /retail|shop|store/i, sector: "Retail", subsector: "High St. Retail" },
  { test: /cold stor/i, sector: "Storage and Distribution", subsector: "Cold Store", scope: "Whole building" },
  { test: /conditioned (storage|warehouse)/i, sector: "Storage and Distribution", subsector: "Conditioned Storage", scope: "Whole building" },
  { test: /warehouse|storage|distribution|logistic|industrial/i, sector: "Storage and Distribution", subsector: "Unconditioned Storage", scope: "Whole building" },
  { test: /hotel/i, sector: "Hotels", subsector: "All building types" },
  { test: /student/i, sector: "Commercial Residential", subsector: "Student" },
  { test: /care home|nursing/i, sector: "Commercial Residential", subsector: "Care homes" },
  { test: /flat|apartment/i, sector: "Homes", subsector: "Flats" },
  { test: /house|home|dwelling|residential/i, sector: "Homes", subsector: "Single Family" },
  { test: /primary school/i, sector: "Schools", subsector: "Primary" },
  { test: /secondary|academy|sixth form/i, sector: "Schools", subsector: "Secondary +" },
  { test: /nursery|early years/i, sector: "Schools", subsector: "Early Years" },
  { test: /school/i, sector: "Schools" },
  { test: /universit|higher education|college/i, sector: "Higher Education", subsector: "All buildings" },
  { test: /hospital|health|clinic|surgery|nhs/i, sector: "Healthcare" },
  { test: /data cent/i, sector: "Data Centres" },
  { test: /lab/i, sector: "Science and Technology", subsector: "Laboratory buildings" },
  { test: /pool|swim/i, sector: "Sport and Leisure", subsector: "Wet" },
  { test: /gym|fitness/i, sector: "Sport and Leisure", subsector: "Fitness" },
  { test: /sport|leisure/i, sector: "Sport and Leisure", subsector: "Dry" },
  { test: /theatre|cinema|performance/i, sector: "Culture and Entertainment", subsector: "Performance" },
  { test: /museum|gallery|library/i, sector: "Culture and Entertainment", subsector: "Collection" },
  { test: /archive/i, sector: "Culture and Entertainment", subsector: "Archives" },
];

/** Maps a free-text property type, or "Sector / Subsector / Scope", to Table 6. */
export function sectorForText(text: string | undefined): SectorMapping | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const parts = raw.split("/").map((p) => p.trim()).filter(Boolean);
  const exact = SECTORS.find((s) => s.toLowerCase() === parts[0].toLowerCase());
  if (exact) {
    return { sector: exact, subsector: parts[1], scope: parts[2], note: parts.length > 1 ? `Sector, subsector and scope as supplied (${raw}).` : `Sector as supplied (${raw}).` };
  }
  for (const s of SYNONYMS) {
    if (s.test.test(raw)) {
      return { sector: s.sector, subsector: s.subsector, scope: s.scope, note: `Property type "${raw}" mapped to ${s.sector}${s.subsector ? ` / ${s.subsector}` : ""}${s.scope ? ` / ${s.scope}` : ""}. Record the Table 6 sector on the asset to make this explicit.` };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* assessment                                                          */
/* ------------------------------------------------------------------ */

function emptyCounts() {
  return { pass: 0, fail: 0, notAssessable: 0, reported: 0, notApplicable: 0 };
}

export function nzcbsAssessment(db: Db, ctx: OperationContext, asset: AssetRecord, meters: AssetMeter[], opts: NzcbsOptions): NzcbsAssessment {
  const carbon = assetCarbon(db, ctx, meters, opts.year);
  const intensity = assetIntensity(carbon, asset.floorAreaM2);
  const factorRefs = carbonFactorReferences(carbon);
  const base = { year: opts.year, intensity, disclaimer: NZCBS_DISCLAIMER, permittedStatement: preVerificationStatement(), rows: [] as NzcbsMetricRow[], counts: emptyCounts(), warnings: [] as string[], assessment: null, limitYear: null, subsector: null, buildingType: null };

  const ref = loadNzcbsReference(ctx.env, opts.version);
  const provenance = (version: string | null, file: string | null, modifiedAt: string | null): AssessmentProvenance => ({ version, file, fileModifiedAt: modifiedAt, factorReferences: factorRefs, referenceDir: ref?.dir ?? deploymentReferenceDir(ctx.env) });
  if (!ref) {
    const loaded = listReferenceVersions(ctx.env).map((v) => v.version).join(", ") || "none";
    const reason = opts.version
      ? `UK NZCBS reference version ${opts.version} is not loaded (loaded: ${loaded}). Supply it as a folder under ${deploymentReferenceDir(ctx.env)} or use a bundled version from ${bundledReferenceDir(ctx.env)}.`
      : `No UK NZCBS reference tables are loaded: neither ${bundledReferenceDir(ctx.env)} nor ${deploymentReferenceDir(ctx.env)} holds a version folder.`;
    return { ...base, assessable: false, sector: opts.sector ?? asset.propertyType ?? null, version: null, summary: "Cannot assess against the UK NZCBS: no reference tables loaded.", reasons: [reason], provenance: provenance(null, null, null) };
  }
  const prov = provenance(ref.version, `${ref.dir}/limits.csv`, ref.modifiedAt);

  const mapping = sectorForText(opts.sector ?? asset.propertyType);
  if (!mapping) {
    const requested = (opts.sector ?? asset.propertyType ?? "").trim();
    return {
      ...base,
      assessable: false,
      sector: requested || null,
      version: ref.version,
      summary: requested ? `Cannot assess against the UK NZCBS: "${requested}" does not map to a Table 6 sector.` : "Cannot assess against the UK NZCBS: no sector.",
      reasons: [requested ? `"${requested}" is not a Table 6 sector and no mapping is known. Sectors: ${SECTORS.join(", ")}. Give the sector as "Sector / Subsector / Scope", for example "Offices / General / Whole building".` : `No sector was supplied and the asset has no property type. Sectors: ${SECTORS.join(", ")}.`],
      provenance: prov,
    };
  }

  const area = asset.floorAreaM2 && asset.floorAreaM2 > 0 ? asset.floorAreaM2 : 0;
  const warnings: string[] = [mapping.note];
  if (area === 0) warnings.push("No floor area is recorded, so no intensity can be computed.");
  else warnings.push("One floor area is recorded; it is used as both GIA and NIA until the asset holds both (4.2.7).");
  warnings.push("Footprint, region, works programmes, occupancy, on-site generation, water, fossil fuel and refrigerant registers are not yet held per asset; those aspects are reported as not assessable with the reason.");

  const profile: BuildingProfile = {
    referenceVersion: ref.version,
    rpep: `${opts.year + 1}-01-01`,
    giaM2: area,
    niaM2: area,
    areas: area > 0 ? [{ sector: mapping.sector, subsector: mapping.subsector, scope: mapping.scope, niaM2: area, giaM2: area }] : [{ sector: mapping.sector, subsector: mapping.subsector, scope: mapping.scope, niaM2: 1, giaM2: 1 }],
    works: [],
    operationalRoute: "one-go",
  };

  const inputs = operationalInputs(ctx, carbon, warnings);
  const result = assessBuilding(ref, profile, inputs);

  const rows: NzcbsMetricRow[] = result.aspects.flatMap((a) =>
    a.findings.map((f: Finding) => ({
      aspect: a.title,
      section: f.section,
      metric: f.metric,
      limitValue: f.limit,
      unit: f.unit,
      year: f.kind === "pass_fail" ? result.limitYear : null,
      assetValue: f.value,
      status: f.status,
      label: STATUS_LABELS[f.status],
      gap: f.gap,
      reason: f.reason,
      notes: f.basis ?? "",
    })),
  );
  const counts = emptyCounts();
  for (const r of rows) {
    if (r.status === "pass") counts.pass++;
    else if (r.status === "fail") counts.fail++;
    else if (r.status === "reported") counts.reported++;
    else if (r.status === "not_applicable") counts.notApplicable++;
    else counts.notAssessable++;
  }
  const eui = rows.find((r) => r.metric === "Energy use intensity");
  const summary =
    `Pre-verification assessment of ${asset.name} against UK NZCBS ${ref.version} as ${result.buildingType}, ${result.classification}${mapping.subsector ? ` / ${mapping.subsector}` : ""}, limits for ${result.limitYear}: ` +
    `${counts.pass} within limit or met, ${counts.fail} above limit or not met, ${counts.notAssessable} not assessable from portal data, ${counts.reported} reporting metrics` +
    (eui && eui.limitValue !== null && eui.assetValue !== null ? `. Operational energy: ${eui.assetValue} against ${eui.limitValue} ${eui.unit} (${eui.label} by ${Math.abs(eui.gap ?? 0)} ${eui.unit}).` : eui && eui.limitValue !== null ? `. Operational energy limit ${eui.limitValue} ${eui.unit}; the asset's figure could not be computed.` : ".") +
    ` Not a verified claim: the building is ${preVerificationStatement()}.`;

  return {
    ...base,
    assessable: true,
    sector: mapping.sector,
    subsector: mapping.subsector ?? null,
    buildingType: result.buildingType,
    limitYear: result.limitYear,
    version: ref.version,
    summary,
    reasons: [],
    rows,
    counts,
    provenance: prov,
    warnings: [...new Set([...warnings, ...result.warnings, ...carbon.warnings])],
    assessment: result,
  };
}

/** Builds the energy inputs from the portal's metered data and the DESNZ factors on the Standard's basis. */
function operationalInputs(ctx: OperationContext, carbon: ReturnType<typeof assetCarbon>, warnings: string[]): OperationalInputs {
  const year = carbon.period.factorYear;
  const gen = desnzFactor(ctx, year, DESNZ_SELECTORS.electricityGenerated, "UK electricity generated");
  const td = desnzFactor(ctx, year, DESNZ_SELECTORS.electricityTandD, "T&D UK electricity");
  const wttGen = desnzFactor(ctx, year, DESNZ_SELECTORS.wttElectricityGeneration, "WTT UK electricity (generation)");
  const wttTd = desnzFactor(ctx, year, DESNZ_SELECTORS.wttElectricityTandD, "WTT UK electricity (T&D)");
  const gas = desnzFactor(ctx, year, DESNZ_SELECTORS.naturalGasGross, "Natural gas, kWh gross CV");
  const wttGas = desnzFactor(ctx, year, DESNZ_SELECTORS.wttNaturalGasGross, "WTT natural gas, kWh gross CV");

  let gridFactors: GridFactors | undefined;
  if (gen.value !== null && td.value !== null && wttGen.value !== null && wttTd.value !== null) {
    gridFactors = { generation: gen.value, transmissionAndDistribution: td.value, wttGeneration: wttGen.value, wttTransmissionAndDistribution: wttTd.value, reference: [gen, td, wttGen, wttTd].map((f) => `${f.source}: ${f.reference}`).join("; ") };
  } else {
    const missing = [gen, td, wttGen, wttTd].filter((f) => f.value === null).map((f) => f.detail ?? f.reference);
    warnings.push(`Grid electricity carbon on the Standard's basis needs four DESNZ lines (5.2.3.4); missing: ${missing.join("; ")}.`);
  }
  const gasFactor = gas.value !== null && wttGas.value !== null ? gas.value + wttGas.value : null;
  if (gasFactor === null && carbon.energy.some((e) => e.utility === "gas" && e.kwh > 0)) {
    warnings.push(`Natural gas carbon on the Standard's basis needs the fuel and WTT lines (5.2.3.3); missing: ${[gas, wttGas].filter((f) => f.value === null).map((f) => f.detail ?? f.reference).join("; ")}.`);
  }

  const supplies: EnergySupply[] = [];
  for (const e of carbon.energy) {
    if (e.direction !== "import" || e.kwh <= 0) continue;
    if (e.utility === "electricity") supplies.push({ kind: "grid_electricity", kwh: e.kwh, measurement: "meter_readings" });
    else supplies.push({ kind: "natural_gas", kwh: e.kwh, measurement: "meter_readings", factorKgCo2ePerKwh: gasFactor, factorReference: gasFactor === null ? undefined : `${gas.source}: ${gas.reference}; ${wttGas.reference}` });
  }
  if (carbon.energy.some((e) => e.direction === "export" && e.kwh > 0)) {
    warnings.push("An export meter is linked but no generation meter, so on-site generation used on site cannot be counted in the EUI or against the renewables target (5.3.2).");
  }
  return { energy: { supplies, gridFactors } };
}
