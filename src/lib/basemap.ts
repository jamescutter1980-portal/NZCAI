import type { StyleSpecification, RequestParameters } from "maplibre-gl";

/**
 * Base map configuration.
 *
 * MapLibre, not Google, per the Site Intelligence brief ("MapLibre by default,
 * Google on paid tiers") and because Google's terms bar two things this module
 * needs to do: digitising electrical infrastructure from satellite imagery, and
 * showing Google content alongside a non-Google map. Our substation, title and
 * constraint layers are our own data, so they belong on an open base map.
 *
 * Two sources, in preference order:
 *
 *  1. Ordnance Survey Data Hub vector tiles, when NEXT_PUBLIC_OS_MAPS_API_KEY
 *     is set. The right answer for a UK product — OS is the authoritative
 *     basemap, and the same key serves the OS bulk products S-01 will need.
 *  2. CARTO raster tiles as a keyless fallback so the app runs out of the box.
 *     Fine for development. Confirm CARTO's terms before relying on it in
 *     production; OS is the intended production source.
 *
 * Attribution is rendered by MapLibre's own AttributionControl and must stay
 * visible whenever these layers are — see the brief, S-01 section 3.4.
 */

const OS_STYLE_URL =
  "https://api.os.uk/maps/vector/v1/vts/resources/styles?srs=3857";

const CARTO_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/attributions">CARTO</a>';

function cartoStyle(dark: boolean): StyleSpecification {
  const theme = dark ? "dark_all" : "light_all";
  return {
    version: 8,
    sources: {
      carto: {
        type: "raster",
        tiles: ["a", "b", "c", "d"].map(
          (s) => `https://${s}.basemaps.cartocdn.com/${theme}/{z}/{x}/{y}@2x.png`,
        ),
        tileSize: 256,
        attribution: CARTO_ATTRIBUTION,
      },
    },
    layers: [{ id: "carto-base", type: "raster", source: "carto" }],
  };
}

/**
 * No-network fallback. If base tiles can't be fetched - offline, a blocked
 * network, an expired OS key - the map falls back to this so our own layers
 * stay visible and usable on a plain ground, rather than a dead grey canvas.
 */
export function offlineStyle(dark: boolean): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: "offline-background",
        type: "background",
        paint: { "background-color": dark ? "#1a1f26" : "#e8ebe6" },
      },
    ],
  };
}

export function osApiKey(): string | undefined {
  return process.env.NEXT_PUBLIC_OS_MAPS_API_KEY || undefined;
}

/** Style URL (OS) or inline style object (CARTO fallback). */
export function basemapStyle(dark: boolean): StyleSpecification | string {
  const key = osApiKey();
  return key ? `${OS_STYLE_URL}&key=${encodeURIComponent(key)}` : cartoStyle(dark);
}

/**
 * OS serves style, sprite, glyph and tile URLs without the key, so append it to
 * every api.os.uk request rather than patching the style document by hand.
 */
export function osTransformRequest(
  url: string,
  _resourceType?: string,
): RequestParameters | undefined {
  const key = osApiKey();
  if (!key || !url.includes("api.os.uk")) return undefined;
  const separator = url.includes("?") ? "&" : "?";
  return url.includes("key=")
    ? { url }
    : { url: `${url}${separator}key=${encodeURIComponent(key)}` };
}

/** Shown in the UI so it is obvious which base map is live. */
export function basemapName(): string {
  return osApiKey() ? "Ordnance Survey" : "CARTO / OpenStreetMap";
}
