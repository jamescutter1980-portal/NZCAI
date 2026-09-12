/**
 * Extraction helpers for ILCD+EPD process datasets served as JSON by soda4LCA
 * nodes (ECO Portal, ÖKOBAUDAT, IBU, EPD Norway, BRE EPD Hub).
 *
 * The JSON is a direct mapping of the ILCD XML. The parts we read:
 *
 *   processInformation.dataSetInformation.UUID
 *   processInformation.dataSetInformation.name.baseName[] {value, lang}
 *   processInformation.dataSetInformation.classificationInformation.classification[].class[] {level, classId, value}
 *   processInformation.time.referenceYear / dataSetValidUntil
 *   processInformation.geography.locationOfOperationSupplyOrProduction.location
 *   processInformation.quantitativeReference.referenceToReferenceFlow[]
 *   modellingAndValidation.LCIMethodAndAllocation.other.anies[] {name:"subType", value}
 *   administrativeInformation.publicationAndOwnership.dataSetVersion
 *   exchanges.exchange[] {dataSetInternalID, referenceFlow, meanAmount, resultingflowAmount,
 *                          flowProperties[] {referenceFlowProperty, referenceUnit, meanValue}}
 *   LCIAResults.LCIAResult[] {referenceToLCIAMethodDataSet {refObjectId, shortDescription[] {value, lang}},
 *                             other.anies[] ({module, scenario?, value} | {name:"referenceToUnitGroupDataSet", value:{shortDescription[]}})}
 *
 * Shape confirmed from open-source clients that parse the same JSON
 * (ocni-dtu/lcax ILCD structs, EPD-to-LCAByg, klimakalkulator, citygmlbrowser).
 * Not exercised against a live node from this environment.
 *
 * Values "ND" (not declared), "MND" (module not declared) and "MNA" (module
 * not assessed) are returned as null with the raw text preserved; they are
 * never read as 0.
 */

export type Json = unknown;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray<T = unknown>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v === undefined || v === null) return [];
  return [v as T];
}

function get(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Picks the English entry of a multilingual {value, lang}[] list, else the first with a value. */
export function pickLang(list: unknown, lang = "en"): string | undefined {
  const items = asArray<Obj>(list).filter(isObj);
  const hit = items.find((i) => i.lang === lang && typeof i.value === "string" && i.value !== "") ?? items.find((i) => typeof i.value === "string" && i.value !== "");
  return hit ? String(hit.value) : undefined;
}

/** Module codes in EN 15978 / EN 15804 order. */
export const MODULE_ORDER = ["A1", "A2", "A3", "A1-A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "C1", "C2", "C3", "C4", "D"];

/** Normalises spellings such as "A1-3", "A1A2A3", "A1,A2,A3" to "A1-A3". */
export function normaliseModule(raw: string): string {
  const m = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (["A1-3", "A1A2A3", "A1,A2,A3", "A1_A3", "A1TOA3", "A1–A3"].includes(m)) return "A1-A3";
  return m;
}

export function moduleSortKey(module: string): number {
  const i = MODULE_ORDER.indexOf(module);
  return i < 0 ? MODULE_ORDER.length + module.charCodeAt(0) : i;
}

export interface ModuleValue {
  module: string;
  scenario?: string;
  /** Numeric value, or null when not declared / not assessed / unparseable. */
  value: number | null;
  /** The raw cell as served, e.g. "12.3", "ND", "MNA". */
  raw: string;
}

export interface IndicatorResult {
  /** Short description as served, e.g. "Global Warming Potential - total (GWP-total)". */
  name: string;
  /** Method dataset UUID if present. */
  methodUuid?: string;
  /** Our classification of the indicator. */
  kind: "GWP-total" | "GWP-fossil" | "GWP-biogenic" | "GWP-luluc" | "GWP-unspecified" | "other";
  unit?: string;
  modules: ModuleValue[];
}

/** Well-known ILCD method UUIDs for climate-change indicators (from public soda4LCA datasets). */
const GWP_METHOD_UUIDS: Record<string, IndicatorResult["kind"]> = {
  "77e416eb-a363-4258-a04e-171d843a6460": "GWP-total", // EN 15804+A2 GWP-total
  "6a37f984-a4b3-458a-a20a-64418c145fa2": "GWP-total", // GWP-GHG (AR5)
  "93a60a56-a3c8-11da-a746-0800200b9a66": "GWP-unspecified", // EN 15804+A1 GWP (AR4)
};

export function classifyIndicator(name: string, methodUuid?: string): IndicatorResult["kind"] {
  if (methodUuid && GWP_METHOD_UUIDS[methodUuid]) return GWP_METHOD_UUIDS[methodUuid];
  const n = name.toLowerCase();
  const isGwp = n.includes("gwp") || n.includes("global warming") || n === "climate change" || n.startsWith("climate change");
  if (!isGwp) return "other";
  if (n.includes("gwp-total") || n.includes("- total") || n.includes("gwp total") || n.includes("gwp-ghg")) return "GWP-total";
  if (n.includes("except") || n.includes("excl")) return "other"; // e.g. "GWP except biogenic carbon" - not comparable to GWP-total
  if (n.includes("fossil")) return "GWP-fossil";
  if (n.includes("biogenic")) return "GWP-biogenic";
  if (n.includes("luluc") || n.includes("land use")) return "GWP-luluc";
  return "GWP-unspecified";
}

export function parseModuleValue(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t === "" || /^(ND|MND|MNA|MNR|INA|NR|N\/A|-)$/i.test(t)) return null;
  const n = Number(t.replace(/,/g, "."));
  return Number.isFinite(n) ? n : null;
}

/** All LCIA results of the process, each with its per-module values. */
export function extractIndicators(process: Json): IndicatorResult[] {
  const results = asArray<Obj>(get(process, "LCIAResults", "LCIAResult")).filter(isObj);
  return results.map((r) => {
    const ref = get(r, "referenceToLCIAMethodDataSet");
    const name = pickLang(get(ref, "shortDescription")) ?? "";
    const methodUuidRaw = get(ref, "refObjectId") ?? get(ref, "@refObjectId");
    const methodUuid = typeof methodUuidRaw === "string" ? methodUuidRaw : undefined;
    const anies = asArray<Obj>(get(r, "other", "anies")).filter(isObj);
    let unit: string | undefined;
    const modules: ModuleValue[] = [];
    for (const a of anies) {
      if (a.name === "referenceToUnitGroupDataSet") {
        unit = pickLang(get(a.value, "shortDescription")) ?? unit;
        continue;
      }
      if (typeof a.module === "string" && a.module !== "") {
        const raw = a.value === undefined || a.value === null ? "" : String(a.value);
        modules.push({
          module: normaliseModule(a.module),
          scenario: typeof a.scenario === "string" && a.scenario !== "" ? a.scenario : undefined,
          value: parseModuleValue(a.value),
          raw,
        });
      }
    }
    modules.sort((x, y) => moduleSortKey(x.module) - moduleSortKey(y.module));
    return { name, methodUuid, kind: classifyIndicator(name, methodUuid), unit, modules };
  });
}

export interface DeclaredUnit {
  amount: number | null;
  unit?: string;
  flowName?: string;
}

/** The declared (functional) unit: reference flow amount and its unit. */
export function extractDeclaredUnit(process: Json): DeclaredUnit {
  const exchanges = asArray<Obj>(get(process, "exchanges", "exchange")).filter(isObj);
  const refIds = asArray(get(process, "processInformation", "quantitativeReference", "referenceToReferenceFlow")).map(String);
  const ref =
    exchanges.find((e) => e.referenceFlow === true) ??
    exchanges.find((e) => refIds.includes(String(e.dataSetInternalID))) ??
    exchanges[0];
  if (!ref) return { amount: null };
  const amountRaw = ref.resultingflowAmount ?? ref.resultingAmount ?? ref.meanAmount;
  const amount = parseModuleValue(amountRaw);
  const props = asArray<Obj>(ref.flowProperties).filter(isObj);
  const prop = props.find((p) => p.referenceFlowProperty === true) ?? props.find((p) => typeof p.referenceUnit === "string") ?? props[0];
  const unit = prop && typeof prop.referenceUnit === "string" ? prop.referenceUnit : undefined;
  const flowName = pickLang(get(ref, "referenceToFlowDataSet", "shortDescription"));
  return { amount, unit, flowName };
}

export interface IlcdSummary {
  uuid?: string;
  name?: string;
  version?: string;
  subType?: string;
  classification: string[];
  referenceYear?: number;
  validUntil?: number;
  geography?: string;
  declaredUnit: DeclaredUnit;
  indicators: IndicatorResult[];
}

export function summariseProcess(process: Json): IlcdSummary {
  const dsi = get(process, "processInformation", "dataSetInformation");
  const uuidRaw = get(dsi, "UUID") ?? get(dsi, "uuid");
  const classes = asArray<Obj>(get(dsi, "classificationInformation", "classification"))
    .filter(isObj)
    .flatMap((c) => asArray<Obj>(c.class).filter(isObj))
    .sort((a, b) => Number(a.level ?? 0) - Number(b.level ?? 0))
    .map((c) => (typeof c.value === "string" ? c.value : String(c.classId ?? "")))
    .filter((s) => s !== "");
  const subType = asArray<Obj>(get(process, "modellingAndValidation", "LCIMethodAndAllocation", "other", "anies"))
    .filter(isObj)
    .find((a) => a.name === "subType");
  const refYear = get(process, "processInformation", "time", "referenceYear");
  const validUntil = get(process, "processInformation", "time", "dataSetValidUntil");
  const version = get(process, "administrativeInformation", "publicationAndOwnership", "dataSetVersion") ?? get(process, "version");
  const geo = get(process, "processInformation", "geography", "locationOfOperationSupplyOrProduction", "location");
  return {
    uuid: typeof uuidRaw === "string" ? uuidRaw : undefined,
    name: pickLang(get(dsi, "name", "baseName")),
    version: typeof version === "string" ? version : undefined,
    subType: subType && typeof subType.value === "string" ? subType.value : undefined,
    classification: classes,
    referenceYear: parseModuleValue(refYear) ?? undefined,
    validUntil: parseModuleValue(validUntil) ?? undefined,
    geography: typeof geo === "string" ? geo : undefined,
    declaredUnit: extractDeclaredUnit(process),
    indicators: extractIndicators(process),
  };
}

/**
 * The GWP indicator to headline: GWP-total, else the A1-era unspecified GWP
 * ("Global warming potential (GWP)" / "Climate change"). Returns undefined
 * when the dataset carries no climate-change indicator.
 */
export function primaryGwp(indicators: IndicatorResult[]): IndicatorResult | undefined {
  return indicators.find((i) => i.kind === "GWP-total") ?? indicators.find((i) => i.kind === "GWP-unspecified");
}

export interface GwpModuleRow {
  indicator: string;
  module: string;
  scenario: string | null;
  value_kgco2e: number | null;
  raw: string;
  availability: "declared" | "not_declared";
  unit: string | null;
  declared_unit: string | null;
}

/** Flat rows (one per indicator x module) for the portal table. */
export function gwpModuleRows(summary: IlcdSummary, kinds: IndicatorResult["kind"][] = ["GWP-total", "GWP-fossil", "GWP-biogenic", "GWP-luluc", "GWP-unspecified"]): GwpModuleRow[] {
  const du = summary.declaredUnit;
  const declaredUnit = du.amount !== null && du.unit ? `${du.amount} ${du.unit}` : (du.unit ?? null);
  const rows: GwpModuleRow[] = [];
  for (const ind of summary.indicators) {
    if (!kinds.includes(ind.kind)) continue;
    for (const m of ind.modules) {
      rows.push({
        indicator: ind.kind === "GWP-unspecified" ? `${ind.name} (unspecified GWP; A1-era)` : ind.kind,
        module: m.module,
        scenario: m.scenario ?? null,
        value_kgco2e: m.value,
        raw: m.raw,
        availability: m.value === null ? "not_declared" : "declared",
        unit: ind.unit ?? null,
        declared_unit: declaredUnit,
      });
    }
  }
  return rows;
}

/** Sum of A1-A3 for an indicator: prefers the aggregated module, else A1+A2+A3 when all three are declared. */
export function a1a3Total(ind: IndicatorResult | undefined): number | null {
  if (!ind) return null;
  const find = (m: string) => ind.modules.find((x) => x.module === m && x.scenario === undefined) ?? ind.modules.find((x) => x.module === m);
  const agg = find("A1-A3");
  if (agg && agg.value !== null) return agg.value;
  const parts = ["A1", "A2", "A3"].map((m) => find(m)?.value ?? null);
  if (parts.every((p) => p !== null)) return parts.reduce<number>((s, p) => s + (p as number), 0);
  return null;
}

/** Standard warnings for any EPD result shown to a user. */
export const EPD_WARNINGS = [
  "Never mix A1-A3 (product stage) with A1-A5 (product plus construction) totals; modules are listed separately and must be summed deliberately.",
  "Compare values only per the same declared unit, geography and standard version (EN 15804+A1 vs +A2 GWP indicators differ).",
  "Check dataSetValidUntil before using an EPD in a new assessment; expired EPDs need justification.",
];

/**
 * soda4LCA process-list entry (GET .../processes?search=true&format=json).
 * Fields seen in ECO Portal and ÖKOBAUDAT responses: uuid, name, version,
 * classific, geo, validUntil, owner, regNo, refYear, subType, nodeid, uri,
 * dsType, dataSetVersion. All are optional here.
 */
export interface ProcessListRow {
  uuid: string;
  name: string | null;
  version: string | null;
  classification: string | null;
  geography: string | null;
  reference_year: number | null;
  valid_until: number | null;
  sub_type: string | null;
  owner: string | null;
  registration_no: string | null;
  node: string | null;
  uri: string | null;
}

export const PROCESS_LIST_COLUMNS: (keyof ProcessListRow)[] = ["uuid", "name", "version", "classification", "geography", "reference_year", "valid_until", "sub_type", "owner", "registration_no", "node", "uri"];

export function mapProcessListEntry(entry: unknown): ProcessListRow | null {
  if (!isObj(entry) || typeof entry.uuid !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null);
  const nameRaw = entry.name;
  const name = typeof nameRaw === "string" ? nameRaw : pickLang(nameRaw) ?? null;
  return {
    uuid: entry.uuid,
    name,
    version: str(entry.version ?? entry.dataSetVersion),
    classification: str(entry.classific),
    geography: str(entry.geo),
    reference_year: parseModuleValue(entry.refYear),
    valid_until: parseModuleValue(entry.validUntil),
    sub_type: str(entry.subType),
    owner: str(entry.owner),
    registration_no: str(entry.regNo),
    node: str(entry.nodeid),
    uri: str(entry.uri),
  };
}

/** Result wrapper of a soda4LCA list call. */
export interface ProcessListPage {
  data?: unknown[];
  totalCount?: number;
  pageSize?: number;
  startIndex?: number;
}
