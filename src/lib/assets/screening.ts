import { randomUUID } from "node:crypto";
import { defaultContext, type OperationContext, type OperationResult } from "@/lib/integrations/framework";
import { getIntegration } from "@/lib/integrations/registry";
import { checkConfigured } from "@/lib/integrations/framework";
import { runSourceOperation, NotConfiguredError } from "@/lib/integrations/service";
import type { AssetRecord } from "./types";
import { formatPostcode } from "./types";

/**
 * One-click environmental and constraint screening for an asset: runs the
 * point-based operations that only need a location, records each outcome
 * (including failures) so the result is honest about coverage.
 */
export interface ScreeningStep {
  sourceId: string;
  opId: string;
  /** Section the result is shown under. */
  section: "identity" | "flood" | "ground" | "heritage_planning" | "nature" | "air" | "grid";
  /** Params derived from the asset; anything the asset lacks disables the step. */
  params: (asset: AssetRecord) => Record<string, unknown> | undefined;
}

const point = (a: AssetRecord) => (a.latitude !== undefined && a.longitude !== undefined ? { latitude: a.latitude, longitude: a.longitude } : undefined);
const postcode = (a: AssetRecord) => (a.postcode ? { postcode: formatPostcode(a.postcode) } : undefined);

export const SCREENING_PROFILE: ScreeningStep[] = [
  { sourceId: "postcodes-io", opId: "lookup", section: "identity", params: postcode },
  { sourceId: "epc-england-wales", opId: "non-domestic-search", section: "identity", params: (a) => (a.uprn ? { uprn: a.uprn, page_size: 10 } : a.postcode ? { postcode: formatPostcode(a.postcode), page_size: 10 } : undefined) },
  { sourceId: "epc-england-wales", opId: "domestic-search", section: "identity", params: (a) => (a.uprn ? { uprn: a.uprn, page_size: 10 } : a.postcode ? { postcode: formatPostcode(a.postcode), page_size: 10 } : undefined) },
  { sourceId: "ea-flood-monitoring", opId: "warnings", section: "flood", params: (a) => point(a) && { ...point(a), dist: 5, minSeverity: "3" } },
  { sourceId: "ea-long-term-flood-risk", opId: "risk-at-point", section: "flood", params: point },
  { sourceId: "ea-environmental-constraints", opId: "constraints-at-point", section: "ground", params: point },
  { sourceId: "coal-authority", opId: "risk-at-point", section: "ground", params: point },
  { sourceId: "bgs-geology", opId: "geology-at-point", section: "ground", params: point },
  { sourceId: "ea-public-registers", opId: "near-point", section: "ground", params: (a) => point(a) && { ...point(a), dist: 0.5 } },
  { sourceId: "historic-england-nhle", opId: "designations-near-point", section: "heritage_planning", params: (a) => point(a) && { ...point(a), distance: 100 } },
  { sourceId: "planning-data", opId: "constraints-at-point", section: "heritage_planning", params: point },
  { sourceId: "natural-england", opId: "designations_near", section: "nature", params: (a) => point(a) && { ...point(a), distance_m: 2000 } },
  { sourceId: "defra-uk-air", opId: "stations-near", section: "air", params: (a) => point(a) && { ...point(a), radius: 10 } },
  { sourceId: "carbon-intensity", opId: "regional_now", section: "grid", params: postcode },
];

/** A warning that reads like a layer or request failure means an empty result is not a clean "nothing found". */
const FAILURE_WORDS = /\b(fail|failed|error|HTTP \d{3}|unavailable|could not|timed out|unreachable|not reached|skipped)\b/i;

export interface ScreeningResult {
  sourceId: string;
  sourceName: string;
  opId: string;
  opLabel: string;
  section: ScreeningStep["section"];
  /** partial: no rows and the source reported problems with some or all layers, so absence is not established. */
  status: "ok" | "empty" | "partial" | "error" | "skipped" | "not_configured";
  summary: string;
  rowCount: number;
  columns?: string[];
  rows?: Record<string, unknown>[];
  warnings?: string[];
  error?: string;
  provenance?: OperationResult["provenance"];
  durationMs: number;
}

export interface ScreeningRun {
  id: string;
  assetId: string;
  ranAt: string;
  results: ScreeningResult[];
  okCount: number;
  partialCount?: number;
  errorCount: number;
}

export async function runScreening(asset: AssetRecord, ctx: OperationContext = defaultContext(), profile = SCREENING_PROFILE): Promise<ScreeningRun> {
  const results: ScreeningResult[] = [];
  for (const step of profile) {
    const def = getIntegration(step.sourceId);
    const op = def?.operations.find((o) => o.id === step.opId);
    if (!def || !op) continue;
    const base: Omit<ScreeningResult, "status" | "summary" | "rowCount" | "durationMs"> = { sourceId: def.id, sourceName: def.name, opId: op.id, opLabel: op.label, section: step.section };
    const params = step.params(asset);
    if (!params) {
      results.push({ ...base, status: "skipped", summary: "Asset has no coordinates or postcode for this check.", rowCount: 0, durationMs: 0 });
      continue;
    }
    const cfg = checkConfigured(def, ctx.env);
    if (!cfg.configured) {
      results.push({ ...base, status: "not_configured", summary: `Needs ${cfg.missing.join(", ")}.`, rowCount: 0, durationMs: 0 });
      continue;
    }
    const started = Date.now();
    try {
      const r = await runSourceOperation(def.id, op.id, params, ctx);
      const rows = r.rows ?? [];
      results.push({
        ...base,
        status: rows.length > 0 ? "ok" : r.warnings?.some((w) => FAILURE_WORDS.test(w)) ? "partial" : "empty",
        summary: r.summary,
        rowCount: rows.length,
        columns: r.columns,
        rows: rows.slice(0, 50),
        warnings: r.warnings,
        provenance: r.provenance,
        durationMs: Date.now() - started,
      });
    } catch (e) {
      const message = e instanceof NotConfiguredError ? e.message : e instanceof Error ? e.message : String(e);
      results.push({ ...base, status: "error", summary: "Check failed.", rowCount: 0, error: message, durationMs: Date.now() - started });
    }
  }
  return {
    id: randomUUID(),
    assetId: asset.id,
    ranAt: ctx.now().toISOString(),
    results,
    okCount: results.filter((r) => r.status === "ok" || r.status === "empty").length,
    partialCount: results.filter((r) => r.status === "partial").length,
    errorCount: results.filter((r) => r.status === "error").length,
  };
}

export const SECTION_LABELS: Record<ScreeningStep["section"], string> = {
  identity: "Identity and certificates",
  flood: "Flood",
  ground: "Ground and environmental liabilities",
  heritage_planning: "Heritage and planning constraints",
  nature: "Nature",
  air: "Air quality",
  grid: "Grid",
};
