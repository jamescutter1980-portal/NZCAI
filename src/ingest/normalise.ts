/**
 * Maps raw portal records onto our canonical columns.
 *
 * Ofgem standardised the capacity heatmap's information model, but portals
 * still differ on casing, separators and local aliases. So each canonical
 * field carries a list of candidate source names, matched case- and
 * separator-insensitively, first hit wins. When verify reports a field we do
 * not recognise, add the alias here rather than reshaping the data upstream.
 */

import type { OdsRecord } from "./opendatasoft";
import { DEMAND_BANDS, GENERATION_BANDS, ragFromHeadroom } from "@/lib/headroom";
import type { Rag } from "@/lib/types";

function canon(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pick(record: OdsRecord, candidates: string[]): unknown {
  const index = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) {
    index.set(canon(key), value);
  }
  for (const candidate of candidates) {
    const hit = index.get(canon(candidate));
    if (hit !== undefined && hit !== null && hit !== "") return hit;
  }
  return undefined;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const cleaned = value.replace(/[, ]/g, "").trim();
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

function asRag(value: unknown): Rag | null {
  const text = asText(value)?.toLowerCase();
  if (!text) return null;
  if (text.startsWith("g")) return "green";
  if (text.startsWith("a") || text.startsWith("y")) return "amber";
  if (text.startsWith("r")) return "red";
  return null;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Opendatasoft geo fields arrive as {lat, lon}, [lat, lon], "lat,lon", or a
 * GeoJSON geometry. Handle all four; anything else is treated as missing.
 */
export function extractLatLng(record: OdsRecord): LatLng | null {
  const raw = pick(record, [
    "geo_point_2d",
    "geopoint",
    "geo_point",
    "coordinates",
    "location",
    "point",
  ]);

  const fromPair = (lat: unknown, lng: unknown): LatLng | null => {
    const la = asNumber(lat);
    const ln = asNumber(lng);
    if (la === null || ln === null) return null;
    if (la < -90 || la > 90 || ln < -180 || ln > 180) return null;
    return { lat: la, lng: ln };
  };

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if ("lat" in obj && ("lon" in obj || "lng" in obj)) {
      return fromPair(obj.lat, obj.lon ?? obj.lng);
    }
    // GeoJSON geometry: coordinates are [lng, lat].
    if (obj.type === "Point" && Array.isArray(obj.coordinates)) {
      const [lng, lat] = obj.coordinates as unknown[];
      return fromPair(lat, lng);
    }
  }
  if (Array.isArray(raw) && raw.length >= 2) {
    return fromPair(raw[0], raw[1]);
  }
  if (typeof raw === "string" && raw.includes(",")) {
    const [lat, lng] = raw.split(",");
    return fromPair(lat, lng);
  }

  // Fall back to discrete columns.
  return fromPair(
    pick(record, ["latitude", "lat", "y"]),
    pick(record, ["longitude", "long", "lon", "lng", "x"]),
  );
}

export interface NormalisedSubstation {
  sourceRef: string;
  name: string | null;
  voltageKv: number | null;
  voltageGroup: string | null;
  latLng: LatLng | null;
  demandHeadroomMva: number | null;
  generationHeadroomMva: number | null;
  demandRag: Rag | null;
  generationRag: Rag | null;
  constraintNote: string | null;
}

export function normaliseSubstation(
  record: OdsRecord,
  fallbackIndex: number,
): NormalisedSubstation | null {
  const sourceRef =
    asText(
      pick(record, [
        "substation_id",
        "substationid",
        "sitefunctionallocation",
        "site_functional_location",
        "asset_id",
        "id",
        "substation_number",
        "nrn",
      ]),
    ) ?? `row-${fallbackIndex}`;

  const name = asText(
    pick(record, [
      "substation_name",
      "substationname",
      "site_name",
      "sitename",
      "name",
      "substation",
    ]),
  );

  const generationHeadroomMva = asNumber(
    pick(record, [
      "generation_headroom_mva",
      "generationheadroom",
      "gen_headroom_mva",
      "generation_capacity_available_mva",
      "available_generation_capacity_mva",
      "generation_headroom",
    ]),
  );

  const demandHeadroomMva = asNumber(
    pick(record, [
      "demand_headroom_mva",
      "demandheadroom",
      "demand_capacity_available_mva",
      "available_demand_capacity_mva",
      "demand_headroom",
    ]),
  );

  const publishedGenRag = asRag(
    pick(record, ["generation_rag", "gen_rag", "generation_rag_rating", "generationragstatus"]),
  );
  const publishedDemandRag = asRag(
    pick(record, ["demand_rag", "demand_rag_rating", "demandragstatus"]),
  );

  // Nothing useful without a name or a reference - skip rather than store noise.
  if (!name && sourceRef.startsWith("row-")) return null;

  return {
    sourceRef,
    name,
    voltageKv: asNumber(
      pick(record, ["voltage_kv", "voltage", "operating_voltage", "system_voltage", "voltagekv"]),
    ),
    voltageGroup: asText(pick(record, ["voltage_group", "voltagegroup", "voltage_level"])),
    latLng: extractLatLng(record),
    demandHeadroomMva,
    generationHeadroomMva,
    // Prefer the DNO's own rating; fall back to our screening bands.
    demandRag: publishedDemandRag ?? ragFromHeadroom(demandHeadroomMva, DEMAND_BANDS),
    generationRag:
      publishedGenRag ?? ragFromHeadroom(generationHeadroomMva, GENERATION_BANDS),
    constraintNote: asText(
      pick(record, ["constraint", "constraint_description", "constraints", "notes", "comment"]),
    ),
  };
}

export interface NormalisedEcr {
  sourceRef: string | null;
  siteName: string | null;
  connectionVoltageKv: number | null;
  importCapacityMva: number | null;
  exportCapacityMva: number | null;
  energySource: string | null;
  connectionStatus: string | null;
  substationName: string | null;
  latLng: LatLng | null;
}

export function normaliseEcr(record: OdsRecord): NormalisedEcr | null {
  const siteName = asText(
    pick(record, ["site_name", "sitename", "customer_site", "name", "customer_name"]),
  );
  const exportCapacityMva = asNumber(
    pick(record, [
      "export_capacity_mva",
      "exportcapacity",
      "registered_capacity_mva",
      "maximum_export_capacity_mva",
      "mec_mva",
    ]),
  );
  const importCapacityMva = asNumber(
    pick(record, [
      "import_capacity_mva",
      "importcapacity",
      "maximum_import_capacity_mva",
      "mic_mva",
    ]),
  );

  if (!siteName && exportCapacityMva === null && importCapacityMva === null) {
    return null;
  }

  return {
    sourceRef: asText(pick(record, ["id", "reference", "connection_reference", "project_id"])),
    siteName,
    connectionVoltageKv: asNumber(
      pick(record, ["connection_voltage_kv", "voltage_kv", "connection_voltage", "voltage"]),
    ),
    importCapacityMva,
    exportCapacityMva,
    energySource: asText(
      pick(record, ["energy_source", "energysource", "technology", "generation_type", "plant_type"]),
    ),
    connectionStatus: asText(
      pick(record, ["connection_status", "status", "project_status"]),
    ),
    substationName: asText(
      pick(record, ["substation_name", "substationname", "connection_point", "bulk_supply_point"]),
    ),
    latLng: extractLatLng(record),
  };
}
