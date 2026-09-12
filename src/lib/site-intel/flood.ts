import type { FloodCheck } from "./constraints";
import { bounds } from "./geo";

/**
 * Environment Agency Flood Map for Planning cross-check.
 *
 * The EA is the authoritative flood source; planning.data.gov.uk carries a
 * copy. Where they disagree the brief requires both to be shown and
 * `source_conflict` raised, rather than quietly preferring one.
 *
 * ENDPOINT UNVERIFIED. This build could not reach environment.data.gov.uk, so
 * the request shape below follows the documented ArcGIS REST convention but has
 * not been exercised against the live service. Every failure - wrong path,
 * changed schema, network - returns `null`, which the cross-check reports as
 * "could not be reached to confirm" rather than as an absence of flood risk.
 * Confirm the service URL before relying on this. See docs/site-intel/PLAN.md.
 */

const DEFAULT_SERVICE =
  "https://environment.data.gov.uk/arcgis/rest/services/EA/FloodMapForPlanningRiversAndSeaFloodZone3/MapServer/0/query";

export interface FloodClientOptions {
  serviceUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Queries the EA service for any flood-zone polygon intersecting the site's
 * bounding box. A box rather than the exact geometry keeps the request inside
 * URL length limits and errs towards reporting risk, which is the safe
 * direction; the caller treats the answer as a cross-check, not a verdict.
 */
export function eaFloodCheck(options: FloodClientOptions = {}): FloodCheck {
  const serviceUrl = options.serviceUrl ?? process.env.EA_FLOOD_SERVICE_URL ?? DEFAULT_SERVICE;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;

  return {
    async inFloodZone(wkt: string): Promise<boolean | null> {
      const box = boundsFromWkt(wkt);
      if (!box) return null;

      const params = new URLSearchParams({
        geometry: box.join(","),
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        returnCountOnly: "true",
        f: "json",
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${serviceUrl}?${params}`, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { count?: number; error?: unknown };
        // An ArcGIS error payload comes back with HTTP 200, so check for it.
        if (body.error || typeof body.count !== "number") return null;
        return body.count > 0;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Minimal WKT POLYGON/MULTIPOLYGON bounds reader, for the envelope query. */
export function boundsFromWkt(wkt: string): [number, number, number, number] | null {
  const pairs = [...wkt.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)];
  if (!pairs.length) return null;

  const ring = pairs.map(([, lon, lat]) => [Number(lon), Number(lat)] as [number, number]);
  return bounds({ type: "Polygon", coordinates: [ring] });
}

/** A flood check that always declines to answer. Used when the EA is disabled. */
export const noFloodCheck: FloodCheck = {
  async inFloodZone() {
    return null;
  },
};
