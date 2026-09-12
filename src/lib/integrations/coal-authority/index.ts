import { defineIntegration, IntegrationHttpError, makeProvenance, simpleHealth, type OperationContext, type OperationResult } from "../framework";
import { wmsCapabilitiesUrl, wmsFeatureInfo, wmsQueryableLayers, type WmsLayerInfo } from "../_shared/wms";

/**
 * Coal Authority open WMS services hosted by BGS:
 *   .../CoalAuthority/coalauthority_coal_mining_reporting_areas/MapServer/WMSServer
 *   .../CoalAuthority/coalauthority_specific_risk/MapServer/WMSServer
 *   .../CoalAuthority/coalauthority_mine_entries/MapServer/WMSServer
 *   .../CoalAuthority/coalauthority_planning_policy_constraints/MapServer/WMSServer
 * Service URLs are confirmed from the published GetCapabilities links. WMS
 * layer names are not documented, so each service's GetCapabilities is read
 * first and every queryable layer is passed to GetFeatureInfo. Not exercised
 * live from this codebase.
 */

export const DEFAULT_BASE = "https://map.bgs.ac.uk/arcgis/services/CoalAuthority";

export const SERVICES = [
  { id: "reporting_areas", path: "coalauthority_coal_mining_reporting_areas/MapServer/WMSServer", label: "Coal mining reporting area" },
  { id: "specific_risk", path: "coalauthority_specific_risk/MapServer/WMSServer", label: "Specific risk (development high risk area, surface mining, mine gas, hazards)" },
  { id: "mine_entries", path: "coalauthority_mine_entries/MapServer/WMSServer", label: "Mine entries (shafts and adits)" },
  { id: "planning_constraints", path: "coalauthority_planning_policy_constraints/MapServer/WMSServer", label: "Planning and policy constraints" },
];

export interface CoalRow extends Record<string, unknown> {
  service: string;
  layer: string;
  hit: boolean | null;
  feature: string | null;
  attributes: string | null;
  status: "hit" | "no feature" | "error";
  message: string | null;
}

export const COLUMNS = ["service", "layer", "hit", "feature", "attributes", "status", "message"];

function nameOf(props: Record<string, unknown>): string | null {
  const lower = new Map(Object.keys(props).map((k) => [k.toLowerCase(), k]));
  for (const n of ["name", "type", "feature_type", "featuretype", "description", "descriptio", "category", "class", "layer", "risk", "status", "treatment", "entry_type"]) {
    const key = lower.get(n);
    if (key !== undefined && props[key] !== null && props[key] !== "" && props[key] !== undefined) return String(props[key]);
  }
  return null;
}

function attributesOf(props: Record<string, unknown>): string | null {
  const s = Object.entries(props)
    .filter(([k, v]) => v !== null && v !== "" && !/^(objectid|shape|shape_area|shape_length|shape\.area|shape\.len)/i.test(k))
    .slice(0, 14)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("; ");
  return s || null;
}

export async function scanCoalServices(ctx: OperationContext, base: string, point: { latitude: number; longitude: number }, serviceIds?: string[]): Promise<{ rows: CoalRow[]; raw: Record<string, unknown>; errors: number }> {
  const rows: CoalRow[] = [];
  const raw: Record<string, unknown> = {};
  let errors = 0;
  const root = base.replace(/\/$/, "");
  for (const svc of SERVICES.filter((s) => !serviceIds || serviceIds.includes(s.id))) {
    const url = `${root}/${svc.path}`;
    let layers: WmsLayerInfo[];
    try {
      layers = await wmsQueryableLayers(ctx, url);
    } catch (e) {
      errors += 1;
      rows.push({ service: svc.label, layer: "(capabilities)", hit: null, feature: null, attributes: null, status: "error", message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!layers.length) {
      rows.push({ service: svc.label, layer: "(capabilities)", hit: null, feature: null, attributes: null, status: "error", message: "no queryable layers listed" });
      continue;
    }
    let res;
    try {
      res = await wmsFeatureInfo(ctx, url, { layers: layers.map((l) => l.name), latitude: point.latitude, longitude: point.longitude, featureCount: 20 });
    } catch (e) {
      errors += 1;
      rows.push({ service: svc.label, layer: layers.map((l) => l.title).join(", "), hit: null, feature: null, attributes: null, status: "error", message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    raw[svc.id] = { url: res.url, format: res.format, features: res.features };
    const titles = new Map(layers.map((l) => [l.name, l.title]));
    const hitLayers = new Set<string>();
    for (const f of res.features) {
      const layerName = f.layer ?? (layers.length === 1 ? layers[0].name : null);
      const title = layerName ? (titles.get(layerName) ?? layerName) : "(layer not stated)";
      if (layerName) hitLayers.add(layerName);
      rows.push({ service: svc.label, layer: title, hit: true, feature: nameOf(f.properties), attributes: attributesOf(f.properties), status: "hit", message: null });
    }
    for (const l of layers) {
      if (!hitLayers.has(l.name) && !(res.features.length && res.features.every((f) => f.layer === null))) {
        rows.push({ service: svc.label, layer: l.title, hit: false, feature: null, attributes: null, status: "no feature", message: null });
      }
    }
    if (res.features.length && res.features.every((f) => f.layer === null) && layers.length > 1) {
      rows.push({ service: svc.label, layer: "(other layers)", hit: null, feature: null, attributes: null, status: "no feature", message: "response did not state which layer each feature came from" });
    }
  }
  return { rows, raw, errors };
}

export const definition = defineIntegration({
  id: "coal-authority",
  name: "Coal Authority mining reporting areas and specific risks",
  group: "ground",
  access: "open",
  territory: "GB",
  description: "Point screening against the Coal Authority's open WMS layers: the coal mining reporting area (whether a CON29M mining report is advisable), development high risk areas, mine entries, surface mining and other recorded hazards, and planning constraints.",
  docsUrl: "https://www.gov.uk/government/organisations/the-coal-authority",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains Coal Authority information licensed under the Open Government Licence v3.0. Re-use is not permitted for any activity that forms part of the Coal Authority's public task (e.g. producing mining reports).",
  licence: "OGL",
  envVars: [{ name: "COAL_AUTHORITY_WMS_BASE", required: false, description: "Override the Coal Authority WMS folder (default https://map.bgs.ac.uk/arcgis/services/CoalAuthority)." }],
  status: "built_unverified",
  notes: [
    "Being inside the coal mining reporting area means a CON29M coal mining report is advisable for a transaction; it does not by itself mean there is mining risk. A development high risk area or a mine entry near the point means the Coal Authority should be consulted before development (a Coal Mining Risk Assessment may be needed).",
    "WMS layer names are not published, so each service's GetCapabilities is read and every queryable layer is queried; layer titles are reported as returned. The WMS is a snapshot of the National Coal Mining Database.",
    "Open data is licensed under OGL with a public-task restriction: it may inform an ESG or acquisition screen but must not be used to produce a mining report or otherwise replicate the Coal Authority's public task.",
    "Not exercised live from this codebase; INFO_FORMAT support (JSON, text, HTML) is negotiated by the WMS helper.",
  ],
  healthCheck: simpleHealth((env) => wmsCapabilitiesUrl(`${(env.COAL_AUTHORITY_WMS_BASE || DEFAULT_BASE).replace(/\/$/, "")}/coalauthority_coal_mining_reporting_areas/MapServer/WMSServer`)),
  operations: [
    {
      id: "risk-at-point",
      label: "Coal mining reporting area and specific risks at a point",
      description: "Whether the point lies in the coal mining reporting area, a development high risk area or other recorded coal mining feature, with the feature attributes.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "53.48" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-1.47" },
        { name: "includePlanning", label: "Also query planning and policy constraints", type: "boolean", default: true },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const base = ctx.env.COAL_AUTHORITY_WMS_BASE || DEFAULT_BASE;
        const ids = SERVICES.map((s) => s.id).filter((id) => id !== "planning_constraints" || params.includePlanning);
        const { rows, raw, errors } = await scanCoalServices(ctx, base, { latitude: params.latitude as number, longitude: params.longitude as number }, ids);
        const usable = rows.filter((r) => r.status !== "error");
        if (!usable.length) {
          const first = rows.find((r) => r.status === "error");
          throw new IntegrationHttpError(`Every Coal Authority WMS failed: ${first?.message ?? "unknown"}`, 502, base, rows.map((r) => `${r.service}: ${r.message}`).join("\n"));
        }
        const inReporting = rows.some((r) => r.service.startsWith("Coal mining reporting") && r.hit);
        const risks = rows.filter((r) => r.hit && !r.service.startsWith("Coal mining reporting"));
        const summary = inReporting
          ? `Within the coal mining reporting area: a CON29M coal mining report is advisable. ${risks.length ? `${risks.length} recorded feature(s) at the point: ${risks.map((r) => `${r.layer}${r.feature ? ` (${r.feature})` : ""}`).join("; ")}.` : "No development high risk area, mine entry or other specific risk feature recorded at the point."}`
          : rows.some((r) => r.service.startsWith("Coal mining reporting") && r.status === "no feature")
            ? "Outside the coal mining reporting area: no coal mining report is normally required."
            : "Coal mining reporting area could not be determined.";
        return {
          summary: `${summary}${errors ? ` ${errors} service(s) could not be queried.` : ""}`,
          columns: COLUMNS,
          rows,
          raw,
          provenance: makeProvenance(definition, ctx, { dataset: "Coal Authority open WMS", basis: "modelled" }),
          warnings: [
            "Reporting area membership indicates that a mining report is advisable, not that mining risk exists; recorded features are a snapshot of the National Coal Mining Database and unrecorded workings may exist.",
            "Open data licence prohibits use for the Coal Authority's public task (e.g. producing mining reports).",
          ],
          links: [
            { label: "Coal Authority interactive map", url: "https://mapapps2.bgs.ac.uk/coalauthority/home.html" },
            { label: "Order a CON29M mining report", url: "https://www.groundstability.com/" },
          ],
        };
      },
    },
  ],
});
