import { defineIntegration, makeProvenance, type HealthResult, type OperationContext } from "../framework";
import { bundledReferenceDir, deploymentReferenceDir, findLimit, listReferenceVersions, loadNzcbsReference, type LimitRow, type NzcbsReference } from "@/lib/nzcbs/reference";
import { STANDARD_VERSION_LABEL } from "@/lib/nzcbs/constants";
import type { AreaBasis, LimitTable } from "@/lib/nzcbs/types";

/**
 * UK Net Zero Carbon Buildings Standard (UK NZCBS) limits and targets.
 *
 * The Rev 1 tables ship with the repository under reference/uk-nzcbs/<version>/
 * (converted from the submission proforma by scripts/nzcbs/convert-proforma-tables.py
 * and checksummed). A later revision can be dropped into
 * data/reference/uk-nzcbs/<version>/ and is picked up by name. The rule engine
 * in src/lib/nzcbs reads the same files; this integration only exposes them on
 * the sources page.
 *
 * A reference table, not a compliance determination: conformity needs the
 * Standard's own method and an approved verifier (sections 4.3, 6 and 7).
 */

const ID = "uk-nzcbs";
export const LINKS = [{ label: "UK Net Zero Carbon Buildings Standard", url: "https://www.nzcbuildings.co.uk/" }];
export const COLUMNS = ["table", "sector", "subsector", "scope", "area_basis", "year", "value", "unit", "status", "note"];

const TABLES: { value: LimitTable; label: string }[] = [
  { value: "OE-1", label: "OE-1 Energy use intensity, New Buildings" },
  { value: "OE-2", label: "OE-2 Energy use intensity, Existing Buildings, one-go route" },
  { value: "OE-3", label: "OE-3 Energy use intensity, Existing Buildings, stepped route" },
  { value: "OE-4", label: "OE-4 Space heating, New Buildings" },
  { value: "EC-1", label: "EC-1 Upfront carbon, New Works" },
  { value: "EC-2", label: "EC-2 Upfront carbon, Retrofit Works" },
  { value: "EC-3", label: "EC-3 Upfront carbon, Reportable Works" },
];

function rowOut(r: LimitRow) {
  return { table: r.table, sector: r.sector, subsector: r.subsector, scope: r.scope, area_basis: r.areaBasis, year: r.year, value: r.value, unit: r.unit, status: r.status, note: r.note };
}

function notLoaded(ctx: OperationContext, requested?: string) {
  const loaded = listReferenceVersions(ctx.env).map((v) => v.version).join(", ") || "none";
  return requested
    ? `UK NZCBS version ${requested} is not loaded (loaded: ${loaded}). Supply it as ${deploymentReferenceDir(ctx.env)}/${requested}/ with its manifest.`
    : `No UK NZCBS reference tables found in ${bundledReferenceDir(ctx.env)} or ${deploymentReferenceDir(ctx.env)}.`;
}

function versionOf(ref: NzcbsReference): string {
  return `${ref.version} (${ref.manifest.standard}); manifest ${ref.manifest.converted_on}`;
}

async function health(ctx: OperationContext): Promise<HealthResult> {
  const started = Date.now();
  try {
    const versions = listReferenceVersions(ctx.env);
    if (versions.length === 0) return { ok: false, detail: notLoaded(ctx), latencyMs: Date.now() - started };
    const ref = loadNzcbsReference(ctx.env);
    return { ok: true, detail: `${versions.length} version(s): ${versions.map((v) => `${v.version}${v.bundled ? " (bundled)" : ""}`).join(", ")}; ${ref?.limits.length ?? 0} limit rows, checksums verified.`, latencyMs: Date.now() - started };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
  }
}

export const definition = defineIntegration({
  id: ID,
  name: "UK Net Zero Carbon Buildings Standard limits",
  group: "pathways",
  access: "download",
  territory: "UK",
  description: `Limits and targets of the UK Net Zero Carbon Buildings Standard, ${STANDARD_VERSION_LABEL}: upfront carbon (Tables EC-1 to EC-3), energy use intensity (OE-1 to OE-3), space heating (OE-4), on-site renewables targets (Annex A3), the refrigerant GWP limit (A4) and the PV upfront carbon limit (EC-5), by sector, subsector, scope and Date of Commencement year.`,
  docsUrl: "https://www.nzcbuildings.co.uk/",
  attribution: "Limits and targets: UK Net Zero Carbon Buildings Standard, Version 1, Rev 1 (April 2026), © Net Zero Carbon Buildings Standard Ltd. Converted from the published submission proforma; verify against the current publication.",
  licence: "restricted",
  envVars: [{ name: "REFERENCE_DATA_DIR", required: false, description: "Directory holding reference files (default data/reference). A later revision of the tables is read from <dir>/uk-nzcbs/<version>/ alongside the bundled reference/uk-nzcbs/<version>/." }],
  status: "built_unverified",
  notes: [
    "The Rev 1 tables are bundled with the repository and checksummed; a table that does not match its manifest is refused. Sample rows were checked by hand against Annex A (see reference/uk-nzcbs/v1r1/README.md).",
    "The submission proforma prints a PV upfront carbon limit of 750 kgCO2e/kWp where the Standard's text prints 1000; both are recorded and the engine uses the Standard's figure until NZCBS Ltd confirms.",
    "Limits vary by Date of Commencement year (4.2.6), building type (Table 4), works type (Table 5), route (5.2.7.1) and, for Offices, the GIA or NIA basis (Table 10). Mixed-Use buildings weight them with Equations 1a and 1b (4.2.5.2); the rule engine in src/lib/nzcbs does that.",
    "A reference table, not a compliance determination. Conformity needs the Standard's method, submission through the proforma and an approved verifier; before verification a building may only be described as targeting verification (7.4.1).",
    "Keep separate from CRREM: the Standard sets limits per sector and year; CRREM models decarbonisation trajectories.",
  ],
  healthCheck: health,
  operations: [
    {
      id: "limits",
      label: "Limits for a sector and year",
      description: "The limit from one Annex A table for a sector, subsector, scope and Date of Commencement year, with the rows considered.",
      params: [
        { name: "table", label: "Table", type: "select", required: true, options: TABLES.map((t) => ({ value: t.value, label: t.label })), default: "OE-2" },
        { name: "sector", label: "Sector", type: "string", required: true, placeholder: "Offices", help: "Table 6 sector name." },
        { name: "subsector", label: "Subsector", type: "string", placeholder: "General", help: "As the table names it, e.g. General, Supermarket, Flats." },
        { name: "scope", label: "Scope", type: "string", placeholder: "Whole building", help: "Offices and Storage: Whole building, Shell & Core + Cat A, Shell & Core only, Landlord-only, Tenant-only, Cat A + Cat B, Cat B." },
        { name: "area_basis", label: "Area basis", type: "select", options: [{ value: "GIA", label: "GIA" }, { value: "NIA", label: "NIA (Offices)" }], help: "Offices may meet either (Table 10)." },
        { name: "year", label: "Date of Commencement year", type: "integer", required: true, min: 2000, max: 2100, placeholder: "2026", help: "Clamped to the published range 2025 to 2050." },
        { name: "version", label: "Reference version", type: "string", placeholder: "v1r1", help: "Defaults to the newest loaded." },
      ],
      async run(params, ctx) {
        const requested = params.version ? String(params.version) : undefined;
        const ref = loadNzcbsReference(ctx.env, requested);
        if (!ref) return { summary: notLoaded(ctx, requested), columns: COLUMNS, rows: [], provenance: makeProvenance(definition, ctx, { dataset: "limits", basis: "unavailable" }), links: LINKS };
        const r = findLimit(ref, { table: params.table as LimitTable, sector: String(params.sector), subsector: params.subsector ? String(params.subsector) : undefined, scope: params.scope ? String(params.scope) : undefined, areaBasis: params.area_basis ? (String(params.area_basis) as AreaBasis) : undefined, year: Number(params.year) });
        const rows = (r.row ? [r.row] : r.candidates).map(rowOut);
        const version = versionOf(ref);
        if (r.status === "limit") {
          return { summary: `${params.table} ${r.year}, ${r.row!.sector}${r.row!.subsector ? ` / ${r.row!.subsector}` : ""}${r.row!.scope ? ` / ${r.row!.scope}` : ""}: ${r.value} ${r.unit}.`, columns: COLUMNS, rows, provenance: makeProvenance(definition, ctx, { dataset: "limits", basis: "measured", version }), warnings: [...r.notes, "A limit, not a determination: the building's own limit may be a weighted figure (4.2.5.2) and depends on its classification."], links: LINKS };
        }
        const basis = r.status === "no_limit" || r.status === "not_applicable" || r.status === "deferred" ? "not_applicable" : "unavailable";
        return { summary: `${params.table} ${r.year}, ${params.sector}: ${r.status.replace(/_/g, " ")}. ${r.notes.join(" ")}`, columns: COLUMNS, rows, provenance: makeProvenance(definition, ctx, { dataset: "limits", basis, version }), warnings: r.notes, links: LINKS };
      },
    },
    {
      id: "renewables_targets",
      label: "On-site renewables targets and other limits",
      description: "Annex A3 targets by region, the A4 refrigerant GWP limit and the PV upfront carbon limit.",
      params: [{ name: "version", label: "Reference version", type: "string", placeholder: "v1r1" }],
      async run(params, ctx) {
        const requested = params.version ? String(params.version) : undefined;
        const ref = loadNzcbsReference(ctx.env, requested);
        if (!ref) return { summary: notLoaded(ctx, requested), columns: ["key", "value", "unit", "note"], rows: [], provenance: makeProvenance(definition, ctx, { dataset: "other-limits", basis: "unavailable" }), links: LINKS };
        const rows = [
          ...ref.renewablesTargets.map((t) => ({ key: `renewables target: ${t.region}, ${t.buildingGroup === "all_other" ? "all other building types" : "Single Family Homes and single-storey Storage and Distribution"}`, value: t.value, unit: t.unit, note: "Annex A3; reducible under 5.3.5.1 (Equation 5, reused systems, kWp floors)." })),
          ...Object.entries(ref.otherLimits).map(([key, v]) => ({ key, value: v.value, unit: v.unit, note: `${v.source}. ${v.note}` })),
        ];
        return { summary: `${ref.renewablesTargets.length} renewables targets and ${Object.keys(ref.otherLimits).length} other limits in ${ref.version}.`, columns: ["key", "value", "unit", "note"], rows, provenance: makeProvenance(definition, ctx, { dataset: "other-limits", basis: "measured", version: versionOf(ref) }), links: LINKS };
      },
    },
    {
      id: "versions",
      label: "Loaded Standard versions",
      description: "Which reference versions are loaded, where from, with sectors and row counts.",
      params: [],
      async run(_params, ctx) {
        const versions = listReferenceVersions(ctx.env);
        const rows = versions.map((v) => {
          const ref = loadNzcbsReference(ctx.env, v.version);
          return { version: v.version, source: v.bundled ? "bundled" : "deployment", dir: v.dir, standard: ref?.manifest.standard ?? "", proforma: ref?.manifest.proforma ?? "", rows: ref?.limits.length ?? 0, sectors: ref?.sectors.join(", ") ?? "", converted_on: ref?.manifest.converted_on ?? "" };
        });
        return {
          summary: rows.length ? `${rows.length} UK NZCBS version(s) loaded: ${rows.map((r) => `${r.version} (${r.source})`).join(", ")}.` : notLoaded(ctx),
          columns: ["version", "source", "dir", "standard", "proforma", "rows", "sectors", "converted_on"],
          rows,
          provenance: makeProvenance(definition, ctx, { dataset: "versions", basis: rows.length ? "measured" : "unavailable" }),
          links: LINKS,
        };
      },
    },
  ],
});
