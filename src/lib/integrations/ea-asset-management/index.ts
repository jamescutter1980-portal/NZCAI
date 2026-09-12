import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationResult } from "../framework";
import { type EaList, lastSegment, num, text, trimItems } from "../ea-flood-monitoring/ea-lda";

/**
 * Environment Agency Asset Management API (alpha): flood and coastal risk
 * management assets (defences, structures, channels, outfalls) with their
 * purpose, protection type, target and actual condition and inspection date.
 * Reference: https://environment.data.gov.uk/asset-management/doc/reference
 * Item shape confirmed from a recorded /id/asset.json response (assetType,
 * assetSubType, primaryPurpose, protectionType, targetCondition,
 * actualCondition, lastInspectionDate, assetLength, waterCourseName, area,
 * maintenanceTask). The lat/long/dist spatial filter follows the platform
 * convention and was not exercised live from this codebase.
 */

export const BASE = "https://environment.data.gov.uk/asset-management";

export interface Asset {
  "@id"?: string;
  notation?: string;
  label?: unknown;
  assetType?: unknown;
  assetSubType?: unknown;
  primaryPurpose?: unknown;
  protectionType?: unknown;
  targetCondition?: unknown;
  actualCondition?: unknown;
  lastInspectionDate?: string;
  assetStartDate?: string;
  assetLength?: number;
  assetLengthUnit?: unknown;
  waterCourseName?: string;
  bank?: unknown;
  area?: unknown;
  maintainedBy?: unknown;
  maintenanceTask?: unknown[];
  actualDcl?: number;
  actualUcl?: number;
  lat?: number;
  long?: number;
  easting?: number;
  northing?: number;
  distance?: number;
}

const COLUMNS = ["asset_id", "asset_type", "asset_sub_type", "primary_purpose", "protection_type", "target_condition", "actual_condition", "condition_vs_target", "last_inspection_date", "asset_start_date", "asset_length_m", "watercourse", "bank", "ea_area", "maintained_by", "maintenance_tasks", "url"];

const CONDITION_RANK: Record<string, number> = { "very good": 1, good: 2, fair: 3, poor: 4, "very poor": 5 };

export function conditionVsTarget(actual: string | null, target: string | null): string | null {
  if (!actual || !target) return null;
  const a = CONDITION_RANK[actual.toLowerCase()];
  const t = CONDITION_RANK[target.toLowerCase()];
  if (a === undefined || t === undefined) return null;
  return a <= t ? "meets target" : "below target";
}

export function assetRow(a: Asset) {
  const actual = text(a.actualCondition);
  const target = text(a.targetCondition);
  const areas = Array.isArray(a.area) ? Array.from(new Set(a.area.map((x) => text(x)).filter(Boolean))).join("; ") : text(a.area);
  const tasks = Array.isArray(a.maintenanceTask)
    ? Array.from(new Set(a.maintenanceTask.map((t) => lastSegment((t as { activityType?: unknown })?.activityType)).filter(Boolean))).join("; ")
    : null;
  return {
    asset_id: a.notation ?? lastSegment(a["@id"]),
    asset_type: text(a.assetType),
    asset_sub_type: text(a.assetSubType),
    primary_purpose: text(a.primaryPurpose),
    protection_type: text(a.protectionType),
    target_condition: target,
    actual_condition: actual,
    condition_vs_target: conditionVsTarget(actual, target),
    last_inspection_date: a.lastInspectionDate ?? null,
    asset_start_date: a.assetStartDate ?? null,
    asset_length_m: num(a.assetLength),
    watercourse: a.waterCourseName ?? null,
    bank: lastSegment(a.bank) ?? null,
    ea_area: areas ?? null,
    maintained_by: text(a.maintainedBy),
    maintenance_tasks: tasks || null,
    url: a["@id"] ?? null,
  };
}

export const definition = defineIntegration({
  id: "ea-asset-management",
  name: "EA flood defence assets (AIMS)",
  group: "flood_water",
  access: "open",
  territory: "England",
  description: "Environment Agency Asset Management API: flood risk management assets (raised defences, structures, outfalls, channels) with purpose, protection type, target versus actual condition and last inspection date.",
  docsUrl: "https://environment.data.gov.uk/asset-management/doc/reference",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains Environment Agency data © Environment Agency and database right. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "Alpha API (meta.comment: 'Asset Management API, alpha'); shapes may change. No key.",
    "Condition grades run Very Good, Good, Fair, Poor, Very Poor; `condition_vs_target` compares actual with target grade and is derived here, not by the EA.",
    "Lists EA-maintained and some third-party assets; absence of an asset near a site does not mean there is no defence, and presence does not mean the site is protected (see Areas Benefiting from Defences on the Flood Map for Planning).",
    "The spatial filter lat/long/dist follows the platform convention used by the flood-monitoring and hydrology APIs and has not been exercised live from this codebase; if it is rejected, the ArcGIS AIMS layers (EA/AIMSInstrument, EA/SpatialFloodDefencesIncStandardisedAttributes) are the alternative.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "id/asset.json", { _limit: 1 })),
  operations: [
    {
      id: "assets-near",
      label: "Flood defence assets near a point",
      description: "Flood risk management assets within a radius of the point with their condition and inspection status.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "51.501" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-0.142" },
        { name: "dist", label: "Radius (km)", type: "number", default: 1, min: 0.1, max: 10 },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const url = buildUrl(BASE, "id/asset.json", { lat: params.latitude as number, long: params.longitude as number, dist: params.dist as number, _limit: 100 });
        const { data } = await fetchJson<EaList<Asset>>(ctx, url);
        const rows = (data.items ?? []).map(assetRow);
        const below = rows.filter((r) => r.condition_vs_target === "below target").length;
        const types = Array.from(new Set(rows.map((r) => r.asset_type).filter(Boolean)));
        return {
          summary: rows.length ? `${rows.length} flood risk management assets within ${params.dist} km (${types.join(", ")}); ${below} below their target condition.` : `No EA-recorded flood risk management assets within ${params.dist} km.`,
          columns: COLUMNS,
          rows,
          raw: trimItems(data),
          provenance: makeProvenance(definition, ctx, { dataset: "asset-management/asset", basis: rows.length ? "measured" : "unavailable" }),
          warnings: ["Asset presence is not proof of protection and condition grades are inspection snapshots; standard of protection is not in this feed."],
        };
      },
    },
  ],
});
