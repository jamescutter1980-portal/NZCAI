import { defineIntegration, makeProvenance, type EnvLike, type IntegrationDefinition, type OperationContext, type OperationResult } from "../framework";
import { csvToRecords, parseNumericCell } from "../_shared/csv";
import { findColumn, normaliseColumn } from "../_shared/columns";
import { fileVersion, listReferenceFiles, loadReferenceFile, referenceDir, referenceHealth, type ReferenceFile } from "../_shared/reference-data";

/**
 * Vehicle Certification Agency (VCA) car fuel consumption and CO2 data,
 * loaded from the CSV downloads saved locally as <year>.csv (for example the
 * "Euro_6_latest" file for the current year, or an archive year's file).
 *
 * Two header generations exist, confirmed from open-source copies of the
 * files (RobWillison/CarData for 2000-2011, ReubenGitHub/ML-Vehicle-Emissions
 * and others for the WLTP-era Euro_6_latest.csv); no file was downloaded
 * here:
 *
 *   NEDC era:  Manufacturer, Model, Description, Transmission, Engine Capacity, Fuel Type,
 *              Metric Urban (Cold), Metric Extra-Urban, Metric Combined, Imperial Urban (Cold),
 *              Imperial Extra-Urban, Imperial Combined, CO2 g/km, Fuel Cost 12000 Miles,
 *              Euro Standard, Noise Level dB(A), Emissions CO [mg/km], THC Emissions [mg/km], ...
 *   WLTP era:  Manufacturer, Model, Description, Transmission, Manual or Automatic, Engine Capacity,
 *              Fuel Type, Powertrain, Engine Power (PS), Engine Power (Kw),
 *              Electric energy consumption Miles/kWh, wh/km, Maximum range (Km), Maximum range (Miles),
 *              Euro Standard, Diesel VED Supplement, Testing Scheme, WLTP Imperial Low ... Combined,
 *              WLTP Metric Low ... Combined, WLTP Metric Combined (Weighted), WLTP CO2, WLTP CO2 Weighted,
 *              Equivalent All Electric Range Miles/KM, Electric Range City Miles/Km, Emissions CO [mg/km],
 *              THC Emissions [mg/km], Emissions NOx [mg/km], THC + NOx Emissions [mg/km],
 *              Particulates [No.] [mg/km], RDE NOx Urban, RDE NOx Combined, Noise Level dB(A), Date of change
 *
 * Columns are matched by normalised name so either generation loads; the
 * row reports which test scheme its figures come from.
 */

export const ID = "vca-fuel-data";
export const FILE_PATTERN = /^(\d{4})(?:[-_].*)?\.csv$/;

export type VehicleRow = {
  year: number;
  manufacturer: string;
  model: string;
  description: string;
  transmission: string;
  engine_cc: number | null;
  fuel_type: string;
  powertrain: string;
  euro_standard: string;
  test_scheme: string;
  co2_g_km: number | null;
  co2_weighted_g_km: number | null;
  /** CO2 to use for reporting: the weighted figure for plug-in hybrids where published, else the combined figure. */
  co2_reporting_g_km: number | null;
  combined_l_100km: number | null;
  combined_mpg: number | null;
  electric_wh_km: number | null;
  electric_miles_kwh: number | null;
  electric_range_km: number | null;
  engine_power_ps: number | null;
  nox_mg_km: number | null;
  noise_db: number | null;
  date_of_change: string;
  file: string;
}

export const COLUMNS: (keyof VehicleRow)[] = ["year", "manufacturer", "model", "description", "transmission", "engine_cc", "fuel_type", "powertrain", "euro_standard", "test_scheme", "co2_g_km", "co2_weighted_g_km", "co2_reporting_g_km", "combined_l_100km", "combined_mpg", "electric_wh_km", "electric_miles_kwh", "electric_range_km", "engine_power_ps", "nox_mg_km", "noise_db", "date_of_change", "file"];

const SPEC: Record<string, string[]> = {
  manufacturer: ["Manufacturer", "Manufacturers", "Maker"],
  model: ["Model"],
  description: ["Description"],
  transmission: ["Transmission"],
  engine: ["Engine Capacity", "Engine Capacity (cc)"],
  fuel: ["Fuel Type"],
  powertrain: ["Powertrain"],
  euro: ["Euro Standard"],
  scheme: ["Testing Scheme"],
  co2: ["WLTP CO2", "CO2 g/km", "CO2"],
  co2_weighted: ["WLTP CO2 Weighted"],
  combined_metric: ["WLTP Metric Combined", "Metric Combined"],
  combined_metric_weighted: ["WLTP Metric Combined (Weighted)"],
  combined_imperial: ["WLTP Imperial Combined", "Imperial Combined"],
  wh_km: ["wh/km", "Electric energy consumption Wh/km"],
  miles_kwh: ["Electric energy consumption Miles/kWh"],
  range_max_km: ["Maximum range (Km)"],
  range_ev_km: ["Equivalent All Electric Range KM"],
  range_city_km: ["Electric Range City Km"],
  power_ps: ["Engine Power (PS)"],
  nox: ["Emissions NOx [mg/km]", "Emissions NOx", "Emissions NOx [g/km]"],
  noise: ["Noise Level dB(A)"],
  date_of_change: ["Date of change"],
};

export interface YearIndex {
  year: number;
  file: ReferenceFile;
  header: string[];
  scheme: "WLTP" | "NEDC" | "mixed";
  rows: VehicleRow[];
  haystack: string[];
}

function isPlugIn(powertrain: string, fuel: string): boolean {
  return /plug-?in|phev/i.test(powertrain) || /plug-?in/i.test(fuel);
}

export function parseVca(text: string, year: number, file: ReferenceFile): YearIndex {
  const table = csvToRecords(text, { isHeader: (row) => row.some((c) => normaliseColumn(c) === "manufacturer" || normaliseColumn(c) === "manufacturers") && row.some((c) => normaliseColumn(c) === "model") });
  const header = table.header;
  const col: Record<string, string | undefined> = {};
  for (const [key, candidates] of Object.entries(SPEC)) {
    const i = findColumn(header, candidates);
    col[key] = i >= 0 ? header[i] : undefined;
  }
  const missing = ["manufacturer", "model", "fuel", "co2"].filter((k) => !col[k]);
  if (missing.length) throw new Error(`${file.name}: missing columns ${missing.join(", ")}. Expected a VCA car fuel data CSV (Manufacturer, Model, Description, Transmission, Engine Capacity, Fuel Type, ... CO2 g/km or WLTP CO2, Euro Standard).`);
  const wltpHeader = !!col.co2 && normaliseColumn(col.co2).startsWith("wltp");
  const get = (r: Record<string, string>, key: string) => (col[key] ? (r[col[key]!] ?? "").trim() : "");
  const num = (r: Record<string, string>, key: string) => parseNumericCell(get(r, key));
  const rows: VehicleRow[] = [];
  let wltp = 0;
  let nedc = 0;
  for (const r of table.records) {
    const manufacturer = get(r, "manufacturer");
    const model = get(r, "model");
    if (!manufacturer && !model) continue;
    const powertrain = get(r, "powertrain");
    const fuel = get(r, "fuel");
    const scheme = get(r, "scheme") || (wltpHeader ? "WLTP" : "NEDC");
    if (/wltp/i.test(scheme)) wltp++;
    else nedc++;
    const co2 = num(r, "co2");
    const co2Weighted = num(r, "co2_weighted");
    const plugIn = isPlugIn(powertrain, fuel);
    const combinedMetric = plugIn && num(r, "combined_metric_weighted") ? num(r, "combined_metric_weighted") : num(r, "combined_metric");
    rows.push({
      year,
      manufacturer,
      model,
      description: get(r, "description"),
      transmission: get(r, "transmission"),
      engine_cc: num(r, "engine"),
      fuel_type: fuel,
      powertrain,
      euro_standard: get(r, "euro"),
      test_scheme: scheme,
      co2_g_km: co2,
      co2_weighted_g_km: co2Weighted,
      co2_reporting_g_km: plugIn && co2Weighted !== null && co2Weighted > 0 ? co2Weighted : co2,
      combined_l_100km: combinedMetric,
      combined_mpg: num(r, "combined_imperial"),
      electric_wh_km: num(r, "wh_km"),
      electric_miles_kwh: num(r, "miles_kwh"),
      electric_range_km: num(r, "range_max_km") ?? num(r, "range_ev_km") ?? num(r, "range_city_km"),
      engine_power_ps: num(r, "power_ps"),
      nox_mg_km: num(r, "nox"),
      noise_db: num(r, "noise"),
      date_of_change: get(r, "date_of_change"),
      file: file.name,
    });
  }
  const haystack = rows.map((r) => `${r.manufacturer} | ${r.model} | ${r.description} | ${r.transmission} | ${r.fuel_type} | ${r.powertrain} | ${r.euro_standard}`.toLowerCase());
  return { year, file, header, scheme: wltp && nedc ? "mixed" : wltp ? "WLTP" : "NEDC", rows, haystack };
}

/** All loaded years, newest first; each file parsed once and cached until it changes. */
export function loadYears(env: EnvLike): YearIndex[] {
  return listReferenceFiles(env, ID, FILE_PATTERN)
    .map((file) => loadReferenceFile(file, (text) => parseVca(text, Number(FILE_PATTERN.exec(file.name)![1]), file)))
    .sort((a, b) => b.year - a.year || a.file.name.localeCompare(b.file.name));
}

export const LINKS = [
  { label: "VCA fuel consumption and CO2 databases (overview)", url: "https://www.vehicle-certification-agency.gov.uk/fuel-consumption-co2/" },
  { label: "Car fuel data downloads (CSV per year / Euro standard)", url: "https://carfueldata.vehicle-certification-agency.gov.uk/downloads/default.aspx" },
  { label: "Car fuel data search tool", url: "https://carfueldata.vehicle-certification-agency.gov.uk/" },
  { label: "GOV.UK: car fuel and CO2 emissions data", url: "https://www.gov.uk/co2-and-vehicle-tax-tools" },
];

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function noYearResult(def: IntegrationDefinition, ctx: OperationContext, requested: number | undefined, years: YearIndex[]): OperationResult {
  const dir = referenceDir(ctx.env, ID);
  const loaded = years.map((y) => y.year).join(", ") || "none";
  return {
    summary: requested === undefined ? `No VCA car fuel data files loaded. Download a CSV from the VCA downloads page and save it as <year>.csv in ${dir}.` : `Year ${requested} is not loaded (loaded: ${loaded}). Save that year's CSV as ${requested}.csv in ${dir}.`,
    columns: COLUMNS,
    rows: [],
    provenance: makeProvenance(def, ctx, { dataset: "car-fuel-data", basis: "unavailable" }),
    links: LINKS,
  };
}

const WARN_LAB = "Figures are laboratory type-approval values supplied by manufacturers (WLTP for cars approved from 2017-2020 onwards, NEDC earlier). Real-world consumption and CO2 are typically higher; for a registered vehicle prefer the DVLA VES co2Emissions field and use these rows to fill gaps by make, model and variant.";
const WARN_PHEV = "For plug-in hybrids the reporting CO2 uses the WLTP weighted (utility-factor) figure where published; the unweighted combined figure is also shown. Battery-electric rows carry no CO2 and report Wh/km instead.";

export const definition = defineIntegration({
  id: ID,
  name: "VCA car fuel data",
  group: "transport",
  access: "download",
  territory: "UK",
  description: "Official type-approval fuel consumption, CO2 and pollutant figures for new cars sold in the UK, published by the Vehicle Certification Agency as CSV downloads and loaded from files saved locally per year. Used for model-level CO2 g/km when the DVLA record has none.",
  docsUrl: "https://www.vehicle-certification-agency.gov.uk/fuel-consumption-co2/",
  termsUrl: "https://www.vehicle-certification-agency.gov.uk/fuel-consumption-co2/car-fuel-data-co2-and-vehicle-tax-tools-disclaimer/",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Vehicle Certification Agency, car fuel data.",
  licence: "OGL",
  envVars: [{ name: "REFERENCE_DATA_DIR", required: false, description: `Directory holding reference files (default data/reference). Files are read from <dir>/${ID}/<year>.csv (a suffix such as 2024-euro6.csv is allowed).` }],
  status: "built_unverified",
  notes: [
    "Supply the files: from the VCA downloads page fetch the CSV (current 'Euro 6 latest' file, or an archive year's file, unzipped) and save it as data/reference/vca-fuel-data/<year>.csv, where <year> is the model year the download covers. The download links are per-release ZIPs behind a form, so no automatic download is offered.",
    "Both header generations are read: NEDC-era files (Manufacturer, Model, Description, Transmission, Engine Capacity, Fuel Type, Metric Combined, Imperial Combined, CO2 g/km, Euro Standard ...) and WLTP-era files (... Powertrain, Testing Scheme, WLTP Metric Combined, WLTP CO2, WLTP CO2 Weighted, wh/km, Maximum range (Km) ...). Layouts were confirmed from open-source copies of the files, not from a live download. Columns are matched by normalised name; each row reports its test scheme.",
    "The VCA files are saved as Windows-1252 ('ANSI'); they are read as UTF-8 here, so a few characters in descriptions (e.g. the pound sign) may show as replacement characters. Re-saving as UTF-8 avoids this.",
    WARN_LAB,
    WARN_PHEV,
  ],
  healthCheck: referenceHealth(ID, FILE_PATTERN, "<year>.csv"),
  operations: [
    {
      id: "search",
      label: "Search by make and model",
      description: "Vehicles matching a manufacturer and optional model, description, fuel type and year, with CO2 g/km, consumption and Euro standard.",
      params: [
        { name: "make", label: "Manufacturer", type: "string", required: true, placeholder: "Toyota", help: "Case-insensitive match on the manufacturer name." },
        { name: "model", label: "Model or description contains", type: "string", placeholder: "Corolla 1.8 Hybrid", help: "All words must appear in the model, description, transmission, fuel or powertrain text." },
        { name: "fuel_type", label: "Fuel type contains", type: "string", placeholder: "Electricity", help: "e.g. Petrol, Diesel, Electricity, Petrol Hybrid, Petrol Plug-in Hybrid." },
        { name: "year", label: "File year", type: "integer", min: 2000, max: 2100, help: "Defaults to every loaded year, newest first." },
        { name: "limit", label: "Max rows", type: "integer", default: 50, min: 1, max: 100 },
      ],
      async run(params, ctx) {
        const years = loadYears(ctx.env);
        const requested = params.year as number | undefined;
        const selected = requested === undefined ? years : years.filter((y) => y.year === requested);
        if (selected.length === 0) return noYearResult(definition, ctx, requested, years);
        const make = norm(String(params.make));
        const words = norm(String(params.model ?? "")).split(" ").filter(Boolean);
        const fuel = params.fuel_type ? norm(String(params.fuel_type)) : undefined;
        const limit = Number(params.limit ?? 50);
        const hits: VehicleRow[] = [];
        let total = 0;
        for (const y of selected) {
          y.rows.forEach((r, i) => {
            if (!norm(r.manufacturer).includes(make)) return;
            if (fuel && !norm(r.fuel_type).includes(fuel)) return;
            const h = y.haystack[i];
            if (!words.every((w) => h.includes(w))) return;
            total++;
            if (hits.length < limit) hits.push(r);
          });
        }
        const co2s = hits.map((h) => h.co2_reporting_g_km).filter((v): v is number => v !== null);
        const warnings = [WARN_LAB];
        if (hits.some((h) => isPlugIn(h.powertrain, h.fuel_type) || h.electric_wh_km !== null)) warnings.push(WARN_PHEV);
        if (total > hits.length) warnings.push(`${total} rows matched; showing the first ${hits.length}. Add model words or a fuel type.`);
        const schemes = [...new Set(hits.map((h) => h.test_scheme))].join("/");
        return {
          summary: total === 0 ? `No VCA rows for "${params.make}"${params.model ? ` ${params.model}` : ""}${fuel ? ` (${params.fuel_type})` : ""} in ${selected.map((y) => y.year).join(", ")}.` : `${total} variant(s) for "${params.make}"${params.model ? ` ${params.model}` : ""} across ${selected.length} file(s) (${schemes}); CO2 ${co2s.length ? `${Math.min(...co2s)}-${Math.max(...co2s)} g/km` : "not published (electric)"}. First: ${hits[0].manufacturer} ${hits[0].model} ${hits[0].description}, ${hits[0].fuel_type}, ${hits[0].co2_reporting_g_km ?? "n/a"} g/km, ${hits[0].euro_standard}.`,
          columns: COLUMNS,
          rows: hits,
          raw: { totalMatches: total, files: selected.map((y) => y.file.name) },
          provenance: makeProvenance(definition, ctx, { dataset: "car-fuel-data", basis: total ? "measured" : "unavailable", version: selected.map((y) => fileVersion(y.file, String(y.year))).join(" | ") }),
          warnings,
          links: LINKS.slice(1, 2),
        };
      },
    },
    {
      id: "files",
      label: "Loaded years",
      description: "Which VCA files are loaded, with row counts and the header generation detected.",
      params: [],
      async run(_params, ctx) {
        const years = loadYears(ctx.env);
        const rows = years.map((y) => ({ year: y.year, file: y.file.name, rows: y.rows.length, test_scheme: y.scheme, manufacturers: new Set(y.rows.map((r) => r.manufacturer.toUpperCase())).size, modified_at: y.file.modifiedAt, size_bytes: y.file.sizeBytes }));
        return {
          summary: rows.length === 0 ? `No VCA files loaded from ${referenceDir(ctx.env, ID)}. Expected <year>.csv.` : `${rows.length} file(s) loaded: ${rows.map((r) => `${r.year} (${r.rows} rows, ${r.test_scheme})`).join(", ")}.`,
          columns: ["year", "file", "rows", "test_scheme", "manufacturers", "modified_at", "size_bytes"],
          rows,
          provenance: makeProvenance(definition, ctx, { dataset: "car-fuel-data", basis: rows.length ? "measured" : "unavailable" }),
          links: LINKS,
        };
      },
    },
    {
      id: "links",
      label: "VCA car fuel data downloads",
      description: "Links to the VCA databases and download page; no data is fetched.",
      params: [],
      async run(_params, ctx) {
        return {
          summary: "VCA car fuel data is a manual CSV download per year and Euro standard; fetch the file for the vehicles of interest and save it as <year>.csv under data/reference/vca-fuel-data/.",
          columns: ["resource", "url"],
          rows: LINKS.map((l) => ({ resource: l.label, url: l.url })),
          links: LINKS,
          provenance: makeProvenance(definition, ctx, { dataset: "car-fuel-data", basis: "not_applicable" }),
        };
      },
    },
  ],
});
