"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type MapMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { RAG_COLOR } from "@/lib/headroom";
import { gridCaveat, isStale } from "@/lib/grid";
import {
  basemapName,
  basemapStyle,
  offlineStyle,
  osApiKey,
  osTransformRequest,
} from "@/lib/basemap";
import type { Rag, Substation } from "@/lib/types";
import type { SiteProfile } from "@/lib/site-intel/types";
import SitePanel, { type SiteMapApi } from "./SitePanel";
import type { ConstraintScreening } from "@/lib/site-intel/constraints";
import {
  CATEGORIES,
  categoryOf,
  summariseCoverage,
  type ConstraintCategory,
  type LayerCoverage,
} from "@/lib/site-intel/constraint-layers";
import type { GridProfile } from "@/lib/site-intel/grid";
import {
  DRAG_START_PX,
  SNAP_EDGE_PX,
  SNAP_PX,
  ALIGN_PX,
  edgeAt,
  hingesForAppend,
  hingesForEdge,
  hingesForVertex,
  linesForAppend,
  linesForEdge,
  linesForVertex,
  regularise,
  selfCrossings,
  simplify,
  insertAfter,
  midpoints,
  moveEdge,
  moveVertex,
  outerRing,
  removeVertex,
  snap,
  snapDraggedEdge,
  targetsFrom,
  toPolygon,
  vertexAt,
  type Assist,
  type BulkOutcome,
  type Crossing,
  type DrawState,
  type Regularised,
  type Simplified,
  type SnapResult,
  type SnapTargets,
  type Vertex,
} from "@/lib/site-intel/draw";
import {
  ECR_MEANING,
  STATUS_LABEL,
  TECHNOLOGIES,
  summariseGridLayers,
  technologyOf,
  type GridLayerCoverage,
} from "@/lib/site-intel/grid-layers";

const GB_CENTRE: [number, number] = [-2.0, 53.2];
const GB_ZOOM = 5.2;
const SOURCE_ID = "substations";
const LAYER_ID = "substation-circles";
const SITE_PIN = "site-pin";
const SITE_TITLE = "site-title";
const SITE_FOOTPRINT = "site-footprint";

/*
 * S-02 constraint layers.
 *
 * `present` and `proximity` are SEPARATE sources with different paint, not one
 * source styled by a property. A proximity polygon drawn like a present one
 * says the site is inside a conservation area when it is merely near one, and
 * that is the single most misleading thing this map could do. Separate layers
 * also make the toggles independent.
 *
 * The search envelope is drawn too: it is a bounding box, not a true buffer,
 * so its corners reach further than the stated metres. Showing it is more
 * honest than letting a reader picture a neat circle.
 */
const CONSTRAINT_PRESENT = "constraint-present";
const CONSTRAINT_PROXIMITY = "constraint-proximity";
const CONSTRAINT_SEARCH = "constraint-search";

/*
 * S-03 grid layers (brief §5.5).
 *
 * The DNO licence-area boundary is deliberately NOT drawn. It is county-sized
 * and the map frames a building, so it would be an edge-to-edge wash carrying
 * no information; the panel states which area the site is in, and the overlap
 * case, in words. What is drawn is the SUPPLY AREA, which is the
 * operationally meaningful polygon and usually absent.
 */
const GRID_SUPPLY_AREA = "grid-supply-area";
const GRID_SITE_SUBS = "grid-site-substations";
const GRID_ECR = "grid-ecr";

/*
 * The redraw tool (brief §3.2, §3.4).
 *
 * Hand-rolled rather than pulled from a draw library. This map has burned two
 * dependencies already - MapLibre v4's XSS in the popup sanitiser and the v6
 * worker that never loaded - and a polygon-by-clicks tool is about eighty
 * lines. Fewer moving parts beats fewer lines here.
 */
const DRAW_LINE = "site-draw-line";
const DRAW_POINTS = "site-draw-points";
const DRAW_MIDS = "site-draw-midpoints";
const DRAW_SNAP = "site-draw-snap";
/** The wall a vertex is snapped to, drawn so the jump is explained. */
const DRAW_SNAP_EDGE = "site-draw-snap-edge";
/**
 * The corner a right angle was applied to. Drawn in AMBER, not the snap blue:
 * blue means the point is on something a source published, amber means it is
 * where we guessed a building would put it.
 */
const DRAW_SQUARE = "site-draw-square";
/**
 * The part of a wall's line that is NOT the wall: where we have carried it on
 * past its end. Dashed, because the solid half is something a source published
 * and this half is our extrapolation of it.
 */
const DRAW_SQUARE_EXT = "site-draw-square-extension";
/**
 * Where the outline crosses itself. RED, and the only red on the editing map:
 * everything else here is a suggestion, and this is the one thing that makes
 * the shape unusable.
 */
const DRAW_CROSS = "site-draw-crossing";
/** Neighbouring OS polygons: context to draw against, and snap targets. */
const NEIGHBOURS = "site-neighbours";

interface ApiResponse {
  substations: Substation[];
  count: number;
  containsSampleData: boolean;
  error?: string;
}

function ragClass(rag: Rag | null): string {
  return rag ?? "unknown";
}

function fmt(value: number | null, unit: string): string {
  return value === null ? "—" : `${value.toFixed(1)} ${unit}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toGeoJson(rows: Substation[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: rows
      .filter((s) => s.lat !== null && s.lng !== null)
      .map((s) => ({
        type: "Feature",
        id: s.id,
        geometry: { type: "Point", coordinates: [s.lng as number, s.lat as number] },
        properties: { id: s.id, rag: ragClass(s.generationRag) },
      })),
  };
}

/**
 * What the indicator should draw for a snap result: the blue ring, the blue
 * wall, the amber pair, the dashed amber extension.
 *
 * One function because there are two callers — a vertex being moved and a wall
 * being moved — and when each built this itself they were free to disagree
 * about what a given result looks like.
 */
function indicatorFor(result: SnapResult): {
  ring: Vertex | null;
  wall: [Vertex, Vertex] | null;
  amber: [Vertex, Vertex][] | null;
  dashed: [Vertex, Vertex] | null;
} {
  /*
   * The blue ring means "this point is on published data". Neither assist puts
   * it there, so both get amber and no ring — and in each case an amber stroke
   * reaches the moved point, so the jump is still explained.
   */
  const onData = result.snapped && result.kind !== "align" && result.kind !== "inline";
  return {
    ring: onData ? result.vertex : null,
    wall: result.edge ? [result.edge.a, result.edge.b] : null,
    amber: result.align
      ? [result.align.reference, [result.align.pivot, result.vertex]]
      : result.line
        ? [[result.line.a, result.line.b]]
        : null,
    // From whichever end of the wall the point went past, out to the point.
    dashed: result.line ? [nearerEnd(result.line, result.vertex), result.vertex] : null,
  };
}

/** Which end of a wall a point lies past, so the dashed part starts there. */
function nearerEnd(
  wall: { a: [number, number]; b: [number, number] },
  point: [number, number],
): [number, number] {
  const da = Math.hypot(point[0] - wall.a[0], point[1] - wall.a[1]);
  const db = Math.hypot(point[0] - wall.b[0], point[1] - wall.b[1]);
  return da <= db ? wall.a : wall.b;
}

/** One wall as a drawable feature. */
function wallFeature(a: [number, number], b: [number, number]): GeoJSON.Feature {
  return { type: "Feature", geometry: { type: "LineString", coordinates: [a, b] }, properties: {} };
}

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function featureOf(geometry: GeoJSON.Geometry | null): GeoJSON.FeatureCollection {
  return geometry
    ? { type: "FeatureCollection", features: [{ type: "Feature", geometry, properties: {} }] }
    : emptyCollection();
}

/**
 * Colour a constraint by its category, via a MapLibre `match` expression on a
 * `category` feature property. Built from CATEGORIES so the legend and the map
 * cannot drift apart.
 */
function categoryColourExpression(): unknown[] {
  const match: unknown[] = ["match", ["get", "category"]];
  for (const c of CATEGORIES) {
    match.push(c.key, c.color);
  }
  match.push(CATEGORIES[CATEGORIES.length - 1].color); // fallback
  return match;
}

/**
 * Flattens a screening into drawable features.
 *
 * One feature per published extent, carrying the dataset, its label, the
 * category and the state, so a click can say exactly what was hit and the
 * paint can colour it without a second lookup.
 */
function constraintFeatures(
  screening: ConstraintScreening | null,
  want: "present" | "proximity",
): GeoJSON.FeatureCollection {
  if (!screening) return emptyCollection();

  const features: GeoJSON.Feature[] = [];
  for (const constraint of screening.constraints) {
    if (constraint.state !== want) continue;
    for (const entity of constraint.entities) {
      if (!entity.geometry) continue;
      features.push({
        type: "Feature",
        geometry: entity.geometry,
        properties: {
          dataset: constraint.dataset,
          label: constraint.label,
          category: categoryOf(constraint.dataset),
          state: constraint.state,
          name: entity.name ?? "",
          reference: entity.reference ?? "",
          message: constraint.message ?? "",
          check: constraint.check ?? "",
          unapproved: constraint.wordingUnapproved ? "1" : "",
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}


/** Colour an ECR point by technology, built from TECHNOLOGIES so the legend agrees. */
function technologyColourExpression(): unknown[] {
  const match: unknown[] = ["match", ["get", "technology"]];
  for (const t of TECHNOLOGIES) match.push(t.key, t.color);
  match.push(TECHNOLOGIES[TECHNOLOGIES.length - 1].color);
  return match;
}

/** Supply-area polygons for the substations returned for a site. */
function supplyAreaFeatures(grid: GridProfile | null): GeoJSON.FeatureCollection {
  if (!grid) return emptyCollection();
  const features: GeoJSON.Feature[] = [];
  for (const s of grid.substations.substations) {
    if (!s.areaGeom) continue;
    features.push({
      type: "Feature",
      geometry: s.areaGeom,
      properties: { name: s.name ?? s.sourceRef, dno: s.dnoName },
    });
  }
  return { type: "FeatureCollection", features };
}

/** The substations this site's screening actually used. */
function siteSubstationFeatures(grid: GridProfile | null): GeoJSON.FeatureCollection {
  if (!grid) return emptyCollection();
  const features: GeoJSON.Feature[] = [];
  for (const s of grid.substations.substations) {
    if (s.lat === null || s.lng === null) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lng, s.lat] },
      properties: {
        name: s.name ?? s.sourceRef,
        rag: s.generationRag ?? "unknown",
        gen: s.generationHeadroomMva,
        dem: s.demandHeadroomMva,
        distance: s.distanceM,
        stale: s.freshness.stale ? "1" : "",
        ragPublished: s.ragPublished ? "1" : "",
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * ECR entries as points.
 *
 * Radius scales with export capacity because a 40 MVA wind farm and a 60 kW
 * rooftop array are not the same fact about the network, and identical dots
 * would say they were.
 */
function ecrFeatures(grid: GridProfile | null): GeoJSON.FeatureCollection {
  if (!grid) return emptyCollection();
  const features: GeoJSON.Feature[] = [];
  for (const e of grid.ecr.entries) {
    if (e.lat === null || e.lng === null) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [e.lng, e.lat] },
      properties: {
        name: e.siteName ?? e.sourceRef ?? "Register entry",
        technology: technologyOf(e.technology),
        technologyRaw: e.technology ?? "",
        status: e.status,
        exportMva: e.exportMva ?? 0,
        distance: e.distanceM,
      },
    });
  }
  return { type: "FeatureCollection", features };
}


function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true
  );
}

interface LandMapProps {
  initialSubstations: Substation[];
  initialHasSample: boolean;
  initialError?: string;
}

export default function LandMap({
  initialSubstations,
  initialHasSample,
  initialError,
}: LandMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const popup = useRef<Popup | null>(null);
  const byId = useRef<Map<number, Substation>>(new Map());
  const geojson = useRef<GeoJSON.FeatureCollection<GeoJSON.Point>>({
    type: "FeatureCollection",
    features: [],
  });
  const swappedToOffline = useRef(false);

  const [ready, setReady] = useState(false);
  // Bumped on every style load so the data push re-runs after a style swap,
  // which destroys and recreates all sources.
  const [styleEpoch, setStyleEpoch] = useState(0);
  const [mapError, setMapError] = useState<string | null>(null);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(initialError ?? null);
  const [substations, setSubstations] = useState<Substation[]>(initialSubstations);
  const [hasSample, setHasSample] = useState(initialHasSample);
  const [selected, setSelected] = useState<number | null>(null);
  const [minHeadroom, setMinHeadroom] = useState(0);
  const [minVoltage, setMinVoltage] = useState(0);

  useEffect(() => {
    byId.current = new Map(substations.map((s) => [s.id, s]));
  }, [substations]);

  /* ---- fetch ------------------------------------------------------------ */

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "5000" });
    if (minHeadroom > 0) params.set("minGenerationHeadroomMva", String(minHeadroom));
    if (minVoltage > 0) params.set("minVoltageKv", String(minVoltage));

    try {
      const res = await fetch(`/api/substations?${params}`);
      const data = (await res.json()) as ApiResponse;
      if (data.error) {
        setLoadError(data.error);
        setSubstations([]);
        return;
      }
      setLoadError(null);
      setSubstations(data.substations);
      setHasSample(data.containsSampleData);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not reach the API");
    }
  }, [minHeadroom, minVoltage]);

  const isFirstLoad = useRef(true);
  useEffect(() => {
    // The server already rendered the unfiltered set - don't refetch it.
    if (isFirstLoad.current) {
      isFirstLoad.current = false;
      return;
    }
    void load();
  }, [load]);

  /* ---- popup ------------------------------------------------------------ */

  const openPopup = useCallback((s: Substation) => {
    const m = map.current;
    if (!m || s.lat === null || s.lng === null) return;

    const stale = isStale(s.ingestedAt)
      ? '<div class="ml-stale">Source data is over 90 days old.</div>'
      : "";

    popup.current?.remove();
    popup.current = new Popup({ closeButton: true, maxWidth: "300px" })
      .setLngLat([s.lng, s.lat])
      .setHTML(
        `<div class="ml-popup">
           <strong>${escapeHtml(s.name ?? s.sourceRef)}</strong>
           <div class="ml-sub">${escapeHtml(s.dnoName)}${s.voltageKv ? ` · ${s.voltageKv} kV` : ""}</div>
           <dl>
             <dt>Generation headroom</dt><dd>${fmt(s.generationHeadroomMva, "MVA")}</dd>
             <dt>Demand headroom</dt><dd>${fmt(s.demandHeadroomMva, "MVA")}</dd>
           </dl>
           ${s.constraintNote ? `<p class="ml-note">${escapeHtml(s.constraintNote)}</p>` : ""}
           ${stale}
           <p class="ml-caveat">${escapeHtml(gridCaveat(s.dnoName, s.ingestedAt))}</p>
         </div>`,
      )
      .addTo(m);
  }, []);

  /* ---- map init --------------------------------------------------------- */

  useEffect(() => {
    if (!container.current || map.current) return;

    // v6 spawns a module worker that imports a sibling shared chunk; neither
    // bundler emits that pair resolvably, so point it at the copies staged in
    // public/ by scripts/copy-maplibre-worker.mjs. Without this the worker
    // never starts and no data layer ever renders.
    setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

    let instance: MapLibreMap;
    try {
      instance = new MapLibreMap({
        container: container.current,
        style: basemapStyle(prefersDark()),
        center: GB_CENTRE,
        zoom: GB_ZOOM,
        // Only attach the transform when there is an OS key to inject; a
        // hook that returns undefined for every request is a no-op at best.
        ...(osApiKey() ? { transformRequest: osTransformRequest } : {}),
        attributionControl: { compact: false },
      });
    } catch (err) {
      setMapError(err instanceof Error ? err.message : "Map failed to initialise");
      return;
    }

    map.current = instance;
    // Namespaced handle for debugging and support in the browser console.
    (window as unknown as { __nzcai?: { map: MapLibreMap } }).__nzcai = { map: instance };
    instance.addControl(new NavigationControl({ showCompass: false }), "top-right");
    instance.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");

    instance.on("error", (e: { error?: { message?: string } }) => {
      const message = e.error?.message ?? "";
      if (!message) return;
      // A failed tile, sprite or glyph fetch is transient and expected on a
      // flaky connection - it degrades the backdrop, not the data. Note it
      // quietly instead of raising an error banner over a working map.
      if (/AJAXError|Failed to fetch|NetworkError/i.test(message)) {
        setTilesFailed(true);
        // A raster source that never resolves keeps the style perpetually
        // "loading", which stops our own layers painting at all. Drop to a
        // plain background once so the substation data stays usable.
        if (!swappedToOffline.current) {
          swappedToOffline.current = true;
          instance.setStyle(offlineStyle(prefersDark()));
          instance.once("styledata", () => {
            addDataLayer(instance);
            setReady(true);
            setStyleEpoch((e) => e + 1);
          });
        }
        return;
      }
      setMapError(message);
    });

    const addDataLayer = (m: MapLibreMap) => {
      if (m.getSource(SOURCE_ID)) return;
      // Seed from the ref: after a style swap the source is recreated, and
      // the data effect below will not re-run on its own.
      m.addSource(SOURCE_ID, { type: "geojson", data: geojson.current });

      m.addLayer({
        id: LAYER_ID,
        type: "circle",
        source: SOURCE_ID,
        paint: {
          // A GPU-rendered circle layer scales to the full ~400k substation
          // set, which per-marker DOM never would.
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 4, 10, 7, 14, 11],
          "circle-color": [
            "match",
            ["get", "rag"],
            "green", RAG_COLOR.green,
            "amber", RAG_COLOR.amber,
            "red", RAG_COLOR.red,
            RAG_COLOR.unknown,
          ],
          "circle-opacity": 0.9,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        },
      });

      // S-02 constraint layers. Added BEFORE the S-01 site layers so the
      // footprint, title extent and pin stay legible on top of them - a
      // green belt fill covers the whole viewport at building zoom, and
      // losing the building under it would defeat the panel above.
      m.addSource(CONSTRAINT_SEARCH, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: CONSTRAINT_SEARCH,
        type: "line",
        source: CONSTRAINT_SEARCH,
        paint: {
          "line-color": "#78838E",
          "line-width": 1,
          "line-dasharray": [2, 3],
        },
      });

      m.addSource(CONSTRAINT_PROXIMITY, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: `${CONSTRAINT_PROXIMITY}-fill`,
        type: "fill",
        source: CONSTRAINT_PROXIMITY,
        paint: {
          "fill-color": categoryColourExpression() as never,
          // Deliberately fainter than `present`, and outlined with a dash
          // below: near is not the same as on, and the map has to say so
          // without the reader clicking anything.
          "fill-opacity": 0.1,
        },
      });
      m.addLayer({
        id: `${CONSTRAINT_PROXIMITY}-line`,
        type: "line",
        source: CONSTRAINT_PROXIMITY,
        paint: {
          "line-color": categoryColourExpression() as never,
          "line-width": 1.5,
          "line-dasharray": [4, 3],
          "line-opacity": 0.8,
        },
      });

      m.addSource(CONSTRAINT_PRESENT, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: `${CONSTRAINT_PRESENT}-fill`,
        type: "fill",
        source: CONSTRAINT_PRESENT,
        paint: {
          "fill-color": categoryColourExpression() as never,
          "fill-opacity": 0.3,
        },
      });
      m.addLayer({
        id: `${CONSTRAINT_PRESENT}-line`,
        type: "line",
        source: CONSTRAINT_PRESENT,
        paint: {
          "line-color": categoryColourExpression() as never,
          "line-width": 2,
        },
      });

      /*
       * S-03 grid layers (brief §5.5). Below the S-01 site layers, above the
       * constraint fills, so the site stays readable and the grid features are
       * not buried under a green belt wash.
       */
      m.addSource(GRID_SUPPLY_AREA, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: `${GRID_SUPPLY_AREA}-fill`,
        type: "fill",
        source: GRID_SUPPLY_AREA,
        paint: { "fill-color": "#1B4DD1", "fill-opacity": 0.06 },
      });
      m.addLayer({
        id: `${GRID_SUPPLY_AREA}-line`,
        type: "line",
        source: GRID_SUPPLY_AREA,
        paint: { "line-color": "#1B4DD1", "line-width": 1.5, "line-dasharray": [6, 3] },
      });

      m.addSource(GRID_ECR, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: GRID_ECR,
        type: "circle",
        source: GRID_ECR,
        paint: {
          // Radius by export capacity: a 40 MVA wind farm and a 60 kW rooftop
          // array are different facts, and equal dots would deny it.
          "circle-radius": [
            "interpolate", ["linear"], ["get", "exportMva"],
            0, 4,
            1, 6,
            10, 11,
            50, 18,
          ],
          "circle-color": technologyColourExpression() as never,
          // Connected is filled; accepted is hollow. An accepted connection is
          // not generating yet, and drawing them alike states something false
          // about the network as it stands.
          "circle-opacity": [
            "match", ["get", "status"],
            "connected", 0.75,
            "accepted", 0.18,
            0.35,
          ],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": technologyColourExpression() as never,
        },
      });

      m.addSource(GRID_SITE_SUBS, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: GRID_SITE_SUBS,
        type: "circle",
        source: GRID_SITE_SUBS,
        paint: {
          // A ring, not a fill: the background substation layer already draws
          // these, and this marks WHICH ones the screening used.
          "circle-radius": 13,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 2.5,
          "circle-stroke-color": [
            "match", ["get", "rag"],
            "green", RAG_COLOR.green,
            "amber", RAG_COLOR.amber,
            "red", RAG_COLOR.red,
            RAG_COLOR.unknown,
          ],
        },
      });

      // S-01 layers: title extent outlined, footprint filled, resolved pin on top.
      m.addSource(SITE_TITLE, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: SITE_TITLE,
        type: "line",
        source: SITE_TITLE,
        paint: { "line-color": "#1B4DD1", "line-width": 2, "line-dasharray": [3, 2] },
      });

      m.addSource(SITE_FOOTPRINT, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: SITE_FOOTPRINT,
        type: "fill",
        source: SITE_FOOTPRINT,
        paint: { "fill-color": "#1B4DD1", "fill-opacity": 0.28, "fill-outline-color": "#1B4DD1" },
      });

      /*
       * Neighbouring buildings, under the drawing. Faint: they are context to
       * draw against and corners to snap to, not findings about the site.
       */
      m.addSource(NEIGHBOURS, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: `${NEIGHBOURS}-fill`,
        type: "fill",
        source: NEIGHBOURS,
        paint: { "fill-color": "#78838E", "fill-opacity": 0.12 },
      });
      m.addLayer({
        id: `${NEIGHBOURS}-line`,
        type: "line",
        source: NEIGHBOURS,
        paint: { "line-color": "#78838E", "line-width": 1 },
      });

      // Above everything: while drawing, the drawing is the subject.
      m.addSource(DRAW_LINE, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: `${DRAW_LINE}-fill`,
        type: "fill",
        source: DRAW_LINE,
        paint: { "fill-color": "#A32F24", "fill-opacity": 0.18 },
      });
      m.addLayer({
        id: DRAW_LINE,
        type: "line",
        source: DRAW_LINE,
        paint: { "line-color": "#A32F24", "line-width": 2, "line-dasharray": [2, 1] },
      });

      // Midpoints: hollow and smaller than a real vertex, because they are a
      // place a vertex COULD go rather than one that exists.
      m.addSource(DRAW_MIDS, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: DRAW_MIDS,
        type: "circle",
        source: DRAW_MIDS,
        paint: {
          "circle-radius": 3.5,
          "circle-color": "rgba(255,255,255,0.55)",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#A32F24",
        },
      });

      m.addSource(DRAW_POINTS, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: DRAW_POINTS,
        type: "circle",
        source: DRAW_POINTS,
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#A32F24",
        },
      });

      /*
       * The snap indicator. A handle that jumps to another coordinate without
       * explanation reads as a bug, so the target is shown while it holds.
       *
       * A corner snap explains itself - there is a visible corner under the
       * ring. A WALL snap does not: the point lands mid-side, where nothing is
       * drawn, and the ring alone would look arbitrary. So the wall that was
       * taken is lit along its whole length.
       */
      m.addSource(DRAW_SNAP_EDGE, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: DRAW_SNAP_EDGE,
        type: "line",
        source: DRAW_SNAP_EDGE,
        paint: { "line-color": "#1B4DD1", "line-width": 3, "line-opacity": 0.8 },
      });

      m.addSource(DRAW_SQUARE_EXT, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: DRAW_SQUARE_EXT,
        type: "line",
        source: DRAW_SQUARE_EXT,
        paint: {
          "line-color": "#B26B00",
          "line-width": 2,
          "line-opacity": 0.75,
          "line-dasharray": [2, 2],
        },
      });

      m.addSource(DRAW_SQUARE, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: DRAW_SQUARE,
        type: "line",
        source: DRAW_SQUARE,
        paint: { "line-color": "#B26B00", "line-width": 3, "line-opacity": 0.85 },
      });

      m.addSource(DRAW_CROSS, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: `${DRAW_CROSS}-line`,
        type: "line",
        source: DRAW_CROSS,
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#C0261B", "line-width": 3 },
      });
      m.addLayer({
        id: DRAW_CROSS,
        type: "circle",
        source: DRAW_CROSS,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 6,
          "circle-color": "#C0261B",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#FFFFFF",
        },
      });

      m.addSource(DRAW_SNAP, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: DRAW_SNAP,
        type: "circle",
        source: DRAW_SNAP,
        paint: {
          "circle-radius": 9,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#1B4DD1",
        },
      });

      m.addSource(SITE_PIN, { type: "geojson", data: emptyCollection() });
      m.addLayer({
        id: SITE_PIN,
        type: "circle",
        source: SITE_PIN,
        paint: {
          "circle-radius": 9,
          "circle-color": "#1B4DD1",
          "circle-stroke-width": 3,
          "circle-stroke-color": "#ffffff",
        },
      });
    };

    instance.on("load", () => {
      addDataLayer(instance);
      setReady(true);
      setStyleEpoch((e) => e + 1);
    });

    /*
     * ONE popup listing EVERY constraint at the clicked point.
     *
     * Per-layer handlers looked simpler and were wrong: a green belt covers
     * the whole viewport, so its fill wins the hit test and a click meant for
     * the flood zone underneath returns the green belt instead. The smaller,
     * more specific constraint becomes unreachable - exactly the one a reader
     * clicked to find out about.
     *
     * queryRenderedFeatures returns everything under the cursor across both
     * layers, and the popup lists all of them with `present` first, so what
     * applies ON the site is read before what is merely near it.
     */
    const CONSTRAINT_FILL_LAYERS = [
      `${CONSTRAINT_PRESENT}-fill`,
      `${CONSTRAINT_PROXIMITY}-fill`,
    ];

    instance.on("click", (e: MapMouseEvent) => {
      if (drawActive.current || picking.current) return;
      const layers = CONSTRAINT_FILL_LAYERS.filter((id) => instance.getLayer(id));
      if (!layers.length) return;

      /*
       * Defer to the point layers. This handler is map-level, so a click on an
       * ECR dot inside a green belt would otherwise open two popups - the
       * specific thing the reader aimed at, and the area they were standing
       * in. The dot is what they clicked.
       */
      const pointLayers = [GRID_ECR, GRID_SITE_SUBS, LAYER_ID].filter((id) =>
        instance.getLayer(id),
      );
      if (pointLayers.length && instance.queryRenderedFeatures(e.point, { layers: pointLayers }).length) {
        return;
      }

      const hits = instance.queryRenderedFeatures(e.point, { layers });
      if (!hits.length) return;

      // Deduplicate: a MultiPolygon can return one feature per part.
      const seen = new Set<string>();
      const items: Record<string, string>[] = [];
      for (const hit of hits) {
        const props = (hit.properties ?? {}) as Record<string, string>;
        const key = `${props.dataset}|${props.reference}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(props);
      }
      items.sort((a, b) => (a.state === "present" ? -1 : 1) - (b.state === "present" ? -1 : 1));

      const body = items
        .map((props) => {
          const where =
            props.state === "present"
              ? "On this site"
              : "Near this site — the site is NOT inside it";
          return `<div class="ml-constraint">
              <p class="ml-title">${escapeHtml(props.label ?? props.dataset ?? "")}</p>
              <p class="ml-where ${props.state}">${escapeHtml(where)}</p>
              ${props.name ? `<p class="ml-sub">${escapeHtml(props.name)}</p>` : ""}
              ${props.reference ? `<p class="ml-ref">${escapeHtml(props.reference)}</p>` : ""}
              ${props.message ? `<p class="ml-msg">${escapeHtml(props.message)}</p>` : ""}
              ${props.check ? `<p class="ml-check">${escapeHtml(props.check)}</p>` : ""}
              ${props.unapproved ? `<p class="ml-note">Wording not signed off.</p>` : ""}
            </div>`;
        })
        .join("");

      new Popup({ closeButton: true, maxWidth: "330px" })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div class="ml-popup">${
            items.length > 1
              ? `<p class="ml-count">${items.length} constraints at this point</p>`
              : ""
          }${body}</div>`,
        )
        .addTo(instance);
    });

    /*
     * Vertex dragging.
     *
     * `mousedown` on a handle claims the pointer and disables map panning -
     * without that the map slides while the vertex stays put, which looks like
     * the handle is broken. Everything is released on `mouseup` wherever it
     * lands, including off the canvas, so a drag that ends outside the map
     * cannot leave panning disabled.
     */
    const screen = (v: Vertex) => {
      const p = instance.project({ lng: v[0], lat: v[1] });
      return { x: p.x, y: p.y };
    };

    /*
     * What a press at this point would grab. One function, used by both the
     * pointer handlers and the cursor, so the cursor can never promise a
     * gesture the press then declines - which is the defect the midpoint
     * cursor had before it was given its own.
     */
    const targetAt = (
      point: { x: number; y: number },
    ): { kind: "vertex" | "midpoint" | "edge"; index: number } | null => {
      const ring = drawing.current as Vertex[];

      const vertex = vertexAt(ring, point, screen);
      if (vertex !== -1) return { kind: "vertex", index: vertex };

      // Walls belong to EDIT mode. In draw mode a click is still placing
      // corners, and a click that lands on the line already drawn has to stay
      // a corner - a concave shape needs exactly that.
      if (appendOnClick.current || ring.length < 3) return null;

      const edge = edgeAt(ring, point, screen);
      if (edge === -1) return null;

      // A press on the midpoint handle is an insert if it does not travel, and
      // a drag of its wall if it does. The wall is the same either way, so the
      // only thing recorded here is which handle was under the pointer.
      const mid = midpoints(ring).find((m) => m.after === edge);
      const onMidpoint =
        mid !== undefined &&
        Math.hypot(screen(mid.vertex).x - point.x, screen(mid.vertex).y - point.y) <= SNAP_PX;

      return { kind: onMidpoint ? "midpoint" : "edge", index: edge };
    };

    instance.on("mousedown", (e: MapMouseEvent) => {
      if (!drawActive.current) return;
      const point = { x: e.point.x, y: e.point.y };
      const target = targetAt(point);
      if (!target) return;

      // Alt- or shift-click removes a vertex instead of dragging it.
      const original = e.originalEvent as MouseEvent;
      if (target.kind === "vertex" && (original?.altKey || original?.shiftKey)) {
        e.preventDefault();
        drawing.current = removeVertex(drawing.current as Vertex[], target.index);
        renderDrawing();
        reportDrawing();
        return;
      }

      e.preventDefault();
      if (target.kind === "vertex") {
        dragging.current = target.index;
        instance.dragPan.disable();
        return;
      }

      /*
       * A wall press is PENDING, not yet a drag: whether it turns into one
       * depends on whether the pointer travels. Panning is disabled now
       * regardless, because by the time the threshold is crossed the map
       * would already have moved under the shape.
       */
      pendingEdge.current = {
        index: target.index,
        onMidpoint: target.kind === "midpoint",
        from: [e.lngLat.lng, e.lngLat.lat],
        at: point,
        travelled: false,
      };
      instance.dragPan.disable();
    });

    instance.on("mousemove", (e: MapMouseEvent) => {
      const point = { x: e.point.x, y: e.point.y };

      if (dragging.current !== null) {
        const vertex = withSnap([e.lngLat.lng, e.lngLat.lat], {
          hinges: hingesForVertex(drawing.current as Vertex[], dragging.current),
          /*
           * The shape's own walls first - a step in this building is a more
           * specific intent than a neighbour's frontage - then the
           * neighbours', which is the building-line case.
           */
          lines: [
            ...linesForVertex(drawing.current as Vertex[], dragging.current),
            ...snapTargets.current.edges,
          ],
        });
        drawing.current = moveVertex(drawing.current as Vertex[], dragging.current, vertex);
        renderDrawing();
        return;
      }

      const pending = pendingEdge.current;
      if (pending) {
        if (
          !pending.travelled &&
          Math.hypot(point.x - pending.at.x, point.y - pending.at.y) < DRAG_START_PX
        ) {
          return;
        }
        pending.travelled = true;
        moveEdgeTo(pending, [e.lngLat.lng, e.lngLat.lat]);
        return;
      }

      // Nothing held: the cursor says what a press here would do.
      if (drawActive.current) {
        const target = targetAt(point);
        instance.getCanvas().style.cursor =
          target === null ? "crosshair"
          : target.kind === "midpoint" ? "copy"
          : "move";

        /*
         * And while placing corners, the indicator previews where the next one
         * would actually land.
         *
         * Without this it only ever appeared for the instant of the click, so
         * a corner that went somewhere other than where the user clicked was
         * never explained - which is the very thing the indicator exists to
         * prevent, and it had been missing from draw mode since snapping was
         * built. The returned vertex is discarded; this is drawn, not applied.
         */
        if (appendOnClick.current) {
          withSnap([e.lngLat.lng, e.lngLat.lat], {
            hinges: hingesForAppend(drawing.current as Vertex[]),
            lines: [
              ...linesForAppend(drawing.current as Vertex[]),
              ...snapTargets.current.edges,
            ],
          });
        }
      }
    });

    const endDrag = (): void => {
      const pending = pendingEdge.current;
      if (pending) {
        pendingEdge.current = null;
        instance.dragPan.enable();
        showSnap(null);
        // A press on a midpoint that never travelled is still a click, and a
        // click on a midpoint inserts a corner there.
        if (!pending.travelled && pending.onMidpoint) {
          drawing.current = insertAfter(
            drawing.current as Vertex[],
            pending.index,
            pending.from,
          );
          renderDrawing();
        }
        reportDrawing();
        return;
      }

      if (dragging.current === null) return;
      dragging.current = null;
      instance.dragPan.enable();
      showSnap(null);
      reportDrawing();
    };
    instance.on("mouseup", endDrag);
    // A pointer released off the canvas still has to release the map.
    instance.getCanvas().addEventListener("mouseleave", endDrag);

    /*
     * Draw-mode clicks add a vertex and nothing else.
     *
     * Registered FIRST and every other click handler bails while drawing, so a
     * click meant to place a corner cannot also open a constraint popup over
     * the shape being drawn.
     */
    instance.on("click", (e: MapMouseEvent) => {
      if (drawActive.current) {
        // In EDIT mode a click on open map must not append a vertex: the ring
        // already exists, and tacking a corner onto the end of it is never
        // what a click on the middle of the map meant. Vertices go in through
        // the midpoint handles instead.
        if (!appendOnClick.current) return;
        /*
         * A click on an existing handle is a grab, never a new corner at the
         * same spot. Clicking the first point to close the ring is a common
         * instinct — in most draw tools it is how you finish — and without
         * this it would silently add a vertex on top of one already there.
         */
        if (
          vertexAt(
            drawing.current as Vertex[],
            { x: e.point.x, y: e.point.y },
            (v) => {
              const p = instance.project({ lng: v[0], lat: v[1] });
              return { x: p.x, y: p.y };
            },
          ) !== -1
        ) {
          return;
        }
        const vertex = withSnap([e.lngLat.lng, e.lngLat.lat], {
          hinges: hingesForAppend(drawing.current as Vertex[]),
          lines: [
            ...linesForAppend(drawing.current as Vertex[]),
            ...snapTargets.current.edges,
          ],
        });
        drawing.current = [...drawing.current, vertex];
        renderDrawing();
        showSnap(null);
        reportDrawing();
        return;
      }

      /*
       * A pick is a POINTER, not a coordinate to store.
       *
       * Brief §3.1 step (e): a map click resolves to the nearest OS Open UPRN
       * within 25 m. The click itself is never persisted - the coordinate that
       * ends up on the profile comes from OS Open UPRN, so the stored lat/lon
       * always agrees with the stored UPRN. The panel does that resolution;
       * this just hands over where the user pointed.
       */
      if (picking.current) {
        const handler = onPick.current;
        picking.current = false;
        onPick.current = null;
        const canvas = instance.getCanvas();
        canvas.style.cursor = "";
        handler?.(e.lngLat.lat, e.lngLat.lng);
      }
    });

    /*
     * ECR popups. Each one repeats what a register entry IS, because the dots
     * are the part of this map most likely to be misread as available capacity.
     */
    instance.on("click", GRID_ECR, (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      if (drawActive.current || picking.current) return;
      const props = e.features?.[0]?.properties as Record<string, string> | undefined;
      if (!props) return;

      const mva = Number(props.exportMva);
      new Popup({ closeButton: true, maxWidth: "300px" })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div class="ml-popup">
             <p class="ml-title">${escapeHtml(props.name ?? "Register entry")}</p>
             <p class="ml-where">${escapeHtml(STATUS_LABEL[props.status] ?? props.status ?? "")}</p>
             <p class="ml-sub">${escapeHtml(props.technologyRaw || "Technology not stated")}${
               Number.isFinite(mva) && mva > 0 ? ` · ${mva} MVA export` : ""
             }</p>
             ${props.distance ? `<p class="ml-ref">${Math.round(Number(props.distance))} m away</p>` : ""}
             <p class="ml-note">${escapeHtml(ECR_MEANING)}</p>
           </div>`,
        )
        .addTo(instance);
    });

    instance.on("click", GRID_SITE_SUBS, (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      if (drawActive.current || picking.current) return;
      const props = e.features?.[0]?.properties as Record<string, string> | undefined;
      if (!props) return;

      new Popup({ closeButton: true, maxWidth: "300px" })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div class="ml-popup">
             <p class="ml-title">${escapeHtml(props.name ?? "Substation")}</p>
             <p class="ml-where">Used for this site's screening</p>
             <p class="ml-sub">Generation ${escapeHtml(props.gen ?? "—")} MVA · Demand ${escapeHtml(props.dem ?? "—")} MVA</p>
             ${props.distance ? `<p class="ml-ref">${Math.round(Number(props.distance))} m away</p>` : ""}
             ${props.ragPublished ? "" : `<p class="ml-note">RAG is our screening band, not the DNO's.</p>`}
             ${props.stale ? `<p class="ml-note">Past the staleness window.</p>` : ""}
           </div>`,
        )
        .addTo(instance);
    });

    /*
     * Hover affordances for the data layers.
     *
     * Silent while drawing or picking, because their clicks are silent then
     * too - every one of those handlers bails on `drawActive`. A "pointer"
     * appearing over a constraint polygon mid-drag would promise a popup that
     * cannot open, and would overwrite the cursor that says what the drag is
     * about to do.
     */
    const hoverable = (): boolean => !drawActive.current && !picking.current;
    for (const layerId of [GRID_ECR, GRID_SITE_SUBS, ...CONSTRAINT_FILL_LAYERS]) {
      instance.on("mouseenter", layerId, () => {
        if (hoverable()) instance.getCanvas().style.cursor = "pointer";
      });
      instance.on("mouseleave", layerId, () => {
        if (hoverable()) instance.getCanvas().style.cursor = "";
      });
    }

    instance.on("click", LAYER_ID, (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
        if (drawActive.current || picking.current) return;
        const id = e.features?.[0]?.properties?.id as number | undefined;
        if (id === undefined) return;
        const s = byId.current.get(Number(id));
        if (s) {
          setSelected(s.id);
          openPopup(s);
        }
      });

    instance.on("mouseenter", LAYER_ID, () => {
      if (hoverable()) instance.getCanvas().style.cursor = "pointer";
    });
    instance.on("mouseleave", LAYER_ID, () => {
      if (hoverable()) instance.getCanvas().style.cursor = "";
    });

    return () => {
      popup.current?.remove();
      instance.remove();
      map.current = null;
      setReady(false);
    };
  }, [openPopup]);

  /* ---- push data into the source ---------------------------------------- */

  useEffect(() => {
    geojson.current = toGeoJson(substations);
    if (!ready || !map.current) return;
    const source = map.current.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(geojson.current);
  }, [ready, substations, styleEpoch]);

  const focus = useCallback(
    (s: Substation) => {
      setSelected(s.id);
      const m = map.current;
      if (!m || s.lat === null || s.lng === null) return;
      m.flyTo({ center: [s.lng, s.lat], zoom: Math.max(m.getZoom(), 11), duration: 600 });
      openPopup(s);
    },
    [openPopup],
  );

  /**
   * Paints the in-progress drawing.
   *
   * Fewer than three points cannot be a polygon, so the line layer carries a
   * LineString until then and a Polygon after. Showing a closed shape with two
   * points would misrepresent what has actually been placed.
   */
  /**
   * Walls that cross, worked out once per render and kept for the report.
   *
   * Not a nicety. A crossed outline has no meaningful area — the shoelace sum
   * gives the two lobes opposite signs and they partly cancel — so this is the
   * one shape defect that would put a wrong number into the database with
   * nothing downstream able to tell.
   */
  const crossings = useRef<Crossing[]>([]);

  const renderDrawing = useCallback(() => {
    const points = drawing.current;
    const m = map.current;
    if (!m) return;

    crossings.current = selfCrossings(points as Vertex[]);
    const cross = m.getSource(DRAW_CROSS) as GeoJSONSource | undefined;
    cross?.setData({
      type: "FeatureCollection",
      features: crossings.current.flatMap((c) => [
        // The two walls at fault AND the point where they meet: the point
        // alone would leave the user hunting for which corner to pull back.
        wallFeature(points[c.a], points[(c.a + 1) % points.length]),
        wallFeature(points[c.b], points[(c.b + 1) % points.length]),
        {
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: c.at },
          properties: {},
        },
      ]),
    });

    const line = m.getSource(DRAW_LINE) as GeoJSONSource | undefined;
    const dots = m.getSource(DRAW_POINTS) as GeoJSONSource | undefined;

    line?.setData(
      points.length >= 3
        ? {
            type: "FeatureCollection",
            features: [{
              type: "Feature",
              geometry: { type: "Polygon", coordinates: [[...points, points[0]]] },
              properties: {},
            }],
          }
        : points.length >= 2
          ? {
              type: "FeatureCollection",
              features: [{
                type: "Feature",
                geometry: { type: "LineString", coordinates: points },
                properties: {},
              }],
            }
          : emptyCollection(),
    );

    dots?.setData({
      type: "FeatureCollection",
      features: points.map((c, i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: c },
        properties: { index: i },
      })),
    });

    // Midpoints only once there is a shape to insert into.
    const mids = m.getSource(DRAW_MIDS) as GeoJSONSource | undefined;
    mids?.setData(
      points.length >= 3
        ? {
            type: "FeatureCollection",
            features: midpoints(points as Vertex[]).map((mp) => ({
              type: "Feature",
              geometry: { type: "Point", coordinates: mp.vertex },
              properties: { after: mp.after },
            })),
          }
        : emptyCollection(),
    );
  }, []);

  /** Tells the panel how the drawing stands: how many points, and whether it crosses. */
  const reportDrawing = useCallback(() => {
    onDrawChange.current?.({
      points: drawing.current.length,
      crossings: crossings.current.length,
    });
  }, []);

  /**
   * Shows or clears the snap indicator: the ring at the point taken, the
   * neighbour's wall behind it in blue, or the squared corner in amber.
   */
  const showSnap = useCallback((
    vertex: Vertex | null,
    wall: [Vertex, Vertex] | null = null,
    aligned: [Vertex, Vertex][] | null = null,
    extension: [Vertex, Vertex] | null = null,
  ) => {
    const point = map.current?.getSource(DRAW_SNAP) as GeoJSONSource | undefined;
    point?.setData(
      vertex
        ? {
            type: "FeatureCollection",
            features: [{
              type: "Feature",
              geometry: { type: "Point", coordinates: vertex },
              properties: {},
            }],
          }
        : emptyCollection(),
    );

    const edge = map.current?.getSource(DRAW_SNAP_EDGE) as GeoJSONSource | undefined;
    edge?.setData(
      wall
        ? {
            type: "FeatureCollection",
            features: [{
              type: "Feature",
              geometry: { type: "LineString", coordinates: wall },
              properties: {},
            }],
          }
        : emptyCollection(),
    );

    /*
     * The wall that was aligned AND the wall its bearing came from. Lighting
     * only the moved wall would not say what it is now parallel or square to,
     * and with a whole building's worth of walls that is a real question. The
     * two meet at the pivot when the reference adjoins it, which draws the
     * familiar elbow; otherwise they are two separate strokes, which is what
     * a parallel actually looks like.
     */
    const square = map.current?.getSource(DRAW_SQUARE) as GeoJSONSource | undefined;
    square?.setData(
      aligned
        ? {
            type: "FeatureCollection",
            features: [{
              type: "Feature",
              geometry: { type: "MultiLineString", coordinates: aligned },
              properties: {},
            }],
          }
        : emptyCollection(),
    );

    const ext = map.current?.getSource(DRAW_SQUARE_EXT) as GeoJSONSource | undefined;
    ext?.setData(
      extension
        ? {
            type: "FeatureCollection",
            features: [{
              type: "Feature",
              geometry: { type: "LineString", coordinates: extension },
              properties: {},
            }],
          }
        : emptyCollection(),
    );
  }, []);

  /**
   * Applies snapping to a raw pointer position.
   *
   * Targets are the neighbouring polygons' corners and walls - not this
   * shape's own. Its own corners would let one collapse onto the corner beside
   * it, and its own walls would hold every vertex at distance zero, so nothing
   * could be dragged at all. The projection comes from the map, so both
   * thresholds are screen pixels at whatever zoom is in force.
   */
  const withSnap = useCallback(
    (lngLat: Vertex, assist: Assist = { hinges: [], lines: [] }): Vertex => {
      const m = map.current;
      const wantSquare =
        squareOn.current && (assist.hinges.length > 0 || assist.lines.length > 0);
      if (!m || (!snapOn.current && !wantSquare)) {
        showSnap(null);
        return lngLat;
      }
      const result = snap(
        lngLat,
        // With snapping off the assist can still run, and vice versa: they are
        // separate toggles because they align to different things.
        snapOn.current ? snapTargets.current : { vertices: [], edges: [] },
        (v) => {
          const p = m.project({ lng: v[0], lat: v[1] });
          return { x: p.x, y: p.y };
        },
        SNAP_PX,
        SNAP_EDGE_PX,
        wantSquare ? assist : { hinges: [], lines: [] },
        ALIGN_PX,
      );
      const shown = indicatorFor(result);
      showSnap(shown.ring, shown.wall, shown.amber, shown.dashed);
      return result.vertex;
    },
    [showSnap],
  );

  /**
   * Moves a whole wall by the pointer's travel since the press.
   *
   * The delta is the POINTER's, not the difference between the cursor and the
   * wall: grabbing a wall near one end and having it jump so its midpoint sits
   * under the cursor is the classic way to make a drag feel broken.
   */
  const moveEdgeTo = useCallback(
    (
      pending: { index: number; from: Vertex },
      to: Vertex,
    ): void => {
      const m = map.current;
      if (!m) return;
      const ring = drawing.current as Vertex[];
      const end = (pending.index + 1) % ring.length;

      const delta: Vertex = [to[0] - pending.from[0], to[1] - pending.from[1]];
      let a: Vertex = [ring[pending.index][0] + delta[0], ring[pending.index][1] + delta[1]];
      // The far end is offered to the snapper too - a wall clicks into place
      // from either of its corners - but only `a` is read back, because the
      // move below is a translation derived from it.
      const b: Vertex = [ring[end][0] + delta[0], ring[end][1] + delta[1]];

      /*
       * A translated wall keeps its own bearing - that is the gesture - so the
       * assist works on the walls either side, which the drag does change. The
       * hinges use `projection` rather than the vertex form: their length is a
       * consequence of the drag, not a choice, and keeping it would hold a
       * rectangle's corner exactly where it started and jam the wall.
       */
      const wantAssist = squareOn.current;
      if (snapOn.current || wantAssist) {
        const project = (v: Vertex) => {
          const p = m.project({ lng: v[0], lat: v[1] });
          return { x: p.x, y: p.y };
        };
        const snapped = snapDraggedEdge(
          a, b,
          snapOn.current ? snapTargets.current : { vertices: [], edges: [] },
          project, SNAP_PX, SNAP_EDGE_PX,
          wantAssist
            ? {
                hinges: hingesForEdge(ring, pending.index),
                lines: [...linesForEdge(ring, pending.index), ...snapTargets.current.edges],
                by: "projection",
              }
            : { hinges: [], lines: [] },
          ALIGN_PX,
        );
        a = snapped.a;
        const shown = indicatorFor(snapped.result);
        showSnap(shown.ring, shown.wall, shown.amber, shown.dashed);
      }

      // The pointer's reference moves with the wall, so the next frame's delta
      // is measured from here. Without it a snap would be re-applied on top of
      // itself and the wall would creep away from the cursor.
      pending.from = [
        pending.from[0] + (a[0] - ring[pending.index][0]),
        pending.from[1] + (a[1] - ring[pending.index][1]),
      ];

      /*
       * Applied through `moveEdge` rather than two `moveVertex` calls: it
       * translates both ends by one delta, so the wall CANNOT come out sheared
       * however the snap landed. Two separate moves would only happen to be
       * rigid, and nothing would catch it if they stopped being.
       */
      drawing.current = moveEdge(ring, pending.index, [
        a[0] - ring[pending.index][0],
        a[1] - ring[pending.index][1],
      ]);
      renderDrawing();
    },
    [renderDrawing, showSnap],
  );

  const setSiteData = useCallback((id: string, data: GeoJSON.FeatureCollection) => {
    const source = map.current?.getSource(id) as GeoJSONSource | undefined;
    source?.setData(data);
  }, []);

  /**
   * Applies a whole-shape change, unless it would leave the outline crossed.
   *
   * Both operations move or remove every corner on an assumption about
   * buildings, and either could in principle fold a very ragged shape through
   * itself. Where the shape was clean before and is not after, the change is
   * REFUSED outright rather than applied and left for the user to notice.
   *
   * Where it was already crossed, the operation goes ahead: it did not cause
   * the fault, refusing would trap the user with no way to tidy the shape, and
   * the warning stands either way.
   */
  const applyBulk = useCallback(<T extends { vertices: Vertex[] }>(
    done: T | null,
  ): BulkOutcome<T> => {
    if (!done) return { ok: false, reason: "nothing" };

    const wasCrossed = crossings.current.length > 0;
    if (!wasCrossed && selfCrossings(done.vertices).length > 0) {
      return { ok: false, reason: "would-cross" };
    }

    beforeBulk.current = drawing.current as Vertex[];
    drawing.current = done.vertices;
    renderDrawing();
    showSnap(null);
    reportDrawing();
    return { ok: true, report: done };
  }, [renderDrawing, showSnap, reportDrawing]);

  const mapApi: SiteMapApi = useMemo(
    () => ({
      showSite(lat, lon) {
        setSiteData(SITE_PIN, {
          type: "FeatureCollection",
          features: [
            { type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: {} },
          ],
        });
        map.current?.flyTo({ center: [lon, lat], zoom: 18, duration: 700 });
      },
      showGeometry(profile: SiteProfile | null) {
        setSiteData(SITE_FOOTPRINT, featureOf(profile?.footprint.geometry ?? null));
        setSiteData(SITE_TITLE, {
          type: "FeatureCollection",
          features: (profile?.titleExtents ?? []).map((t) => ({
            type: "Feature",
            geometry: t.geometry,
            properties: {},
          })),
        });
      },
      showConstraints(screening: ConstraintScreening | null) {
        setSiteData(CONSTRAINT_PRESENT, constraintFeatures(screening, "present"));
        setSiteData(CONSTRAINT_PROXIMITY, constraintFeatures(screening, "proximity"));
        setSiteData(
          CONSTRAINT_SEARCH,
          featureOf(screening?.searchArea.envelope ?? null),
        );

        /*
         * Frame the map on the area that was actually searched.
         *
         * showSite() flies to zoom 18, which is right for "is this the
         * building?" and wrong the moment constraints are drawn: a green belt
         * or conservation area covers the whole viewport at that zoom and
         * reads as a colour wash rather than a boundary. The search envelope
         * is the honest frame - it is the area screened, it is already drawn,
         * and anything extending past it is genuinely off-screen rather than
         * omitted.
         */
        const envelope = screening?.searchArea.envelope;
        if (envelope && envelope.type === "Polygon") {
          const ring = (envelope as GeoJSON.Polygon).coordinates[0] ?? [];
          if (ring.length) {
            const lngs = ring.map((c) => c[0]);
            const lats = ring.map((c) => c[1]);
            map.current?.fitBounds(
              [
                [Math.min(...lngs), Math.min(...lats)],
                [Math.max(...lngs), Math.max(...lats)],
              ],
              { padding: 90, maxZoom: 17.5, duration: 600 },
            );
          }
        }
        setCoverage(
          screening
            ? summariseCoverage(
                screening.constraints.map((c) => ({
                  dataset: c.dataset,
                  state: c.state,
                  label: c.label,
                  entityCount: c.entities.length,
                  entityGeometryCount: c.entities.filter((e) => e.geometry).length,
                })),
              )
            : null,
        );
      },
      showGrid(grid: GridProfile | null) {
        setSiteData(GRID_SUPPLY_AREA, supplyAreaFeatures(grid));
        setSiteData(GRID_SITE_SUBS, siteSubstationFeatures(grid));
        setSiteData(GRID_ECR, ecrFeatures(grid));

        const points: [number, number][] = [];
        for (const s of grid?.substations.substations ?? []) {
          if (s.lat !== null && s.lng !== null) points.push([s.lng, s.lat]);
        }
        for (const e of grid?.ecr.entries ?? []) {
          if (e.lat !== null && e.lng !== null) points.push([e.lng, e.lat]);
        }
        gridBounds.current = points.length
          ? [
              [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))],
              [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))],
            ]
          : null;
        setGridCoverage(
          grid
            ? summariseGridLayers({
                substations: grid.substations.substations.map((x) => ({
                  lat: x.lat,
                  lng: x.lng,
                  stale: x.freshness.stale,
                  hasArea: Boolean(x.areaGeom),
                })),
                ecr: grid.ecr.entries.map((e) => ({ lat: e.lat, lng: e.lng })),
                method: grid.substations.method,
                unplaceable: {
                  substations: grid.placement.substationsWithoutPoint,
                  ecr: grid.placement.ecrWithoutPoint,
                },
              })
            : null,
        );
      },
      /**
       * Next map click reports where the user pointed.
       *
       * Deliberately one-shot: a mode that stays on invites a second click
       * that silently re-resolves the site after the user thought they were
       * done.
       */
      startPick(handler: (lat: number, lon: number) => void) {
        // Drawing and picking cannot both own the next click.
        drawing.current = [];
        drawActive.current = false;
        onDrawChange.current = null;
        renderDrawing();

        picking.current = true;
        onPick.current = handler;
        const canvas = map.current?.getCanvas();
        if (canvas) canvas.style.cursor = "crosshair";
      },

      cancelPick() {
        picking.current = false;
        onPick.current = null;
        const canvas = map.current?.getCanvas();
        if (canvas) canvas.style.cursor = "";
      },

      startDraw(onChange: (state: DrawState) => void) {
        // Same rule the other way round.
        picking.current = false;
        onPick.current = null;
        drawing.current = [];
        drawActive.current = true;
        appendOnClick.current = true;
        beforeBulk.current = null;
        onDrawChange.current = onChange;
        renderDrawing();
        reportDrawing();
        const canvas = map.current?.getCanvas();
        if (canvas) canvas.style.cursor = "crosshair";
      },

      /**
       * Edits the shape already on the profile instead of starting empty.
       *
       * This is the common correction - the published polygon is right except
       * for one corner - and it produces the same T4 override as a redraw,
       * because a footprint with a moved corner is no longer what OS
       * published. Returns false when there is nothing editable.
       */
      startEdit(geometry: GeoJSON.Geometry | null, onChange: (state: DrawState) => void): boolean {
        const ring = outerRing(geometry);
        if (ring.length < 3) return false;

        picking.current = false;
        onPick.current = null;
        drawing.current = ring;
        drawActive.current = true;
        beforeBulk.current = null;
        // A click on open map must not append to an existing ring.
        appendOnClick.current = false;
        onDrawChange.current = onChange;
        renderDrawing();
        reportDrawing();
        const canvas = map.current?.getCanvas();
        if (canvas) canvas.style.cursor = "crosshair";
        return true;
      },

      setSnap(on: boolean) {
        snapOn.current = on;
        if (!on) showSnap(null);
      },

      setSquare(on: boolean) {
        squareOn.current = on;
        if (!on) showSnap(null);
      },

      /**
       * Squares the whole shape up against its own grid.
       *
       * Keeps ONE snapshot so it can be taken back. Undo point is hidden in
       * edit mode (§2p) because there is nothing of the user's to undo there -
       * but this is something of theirs, and a wholesale change to every
       * corner at that, so it needs its own way back that is not "cancel the
       * entire edit".
       */
      squareUp(): BulkOutcome<Regularised> {
        return applyBulk(regularise(drawing.current as Vertex[]));
      },

      /**
       * Drops corners that carry no shape.
       *
       * Deliberately NOT part of squaring, which keeps a corner whose walls
       * come out near-collinear: dropping a vertex the user placed is a
       * separate decision and gets a separate button.
       */
      simplifyShape(): BulkOutcome<Simplified> {
        return applyBulk(simplify(drawing.current as Vertex[]));
      },

      undoBulkEdit(): boolean {
        const before = beforeBulk.current;
        if (!before) return false;
        beforeBulk.current = null;
        drawing.current = before;
        renderDrawing();
        reportDrawing();
        return true;
      },

      showNeighbours(
        buildings: { geometry: GeoJSON.Geometry; label: string }[],
      ) {
        neighbours.current = buildings;
        // Built once here rather than on every pointer move: a dense street is
        // a few thousand corners and walls, and `mousemove` fires on every
        // frame of a drag.
        snapTargets.current = targetsFrom(buildings);
        setSiteData(NEIGHBOURS, {
          type: "FeatureCollection",
          features: buildings.map((b) => ({
            type: "Feature",
            geometry: b.geometry,
            properties: { label: b.label },
          })),
        });
      },

      undoDrawPoint() {
        drawing.current = drawing.current.slice(0, -1);
        renderDrawing();
        reportDrawing();
      },

      cancelDraw() {
        drawing.current = [];
        drawActive.current = false;
        appendOnClick.current = true;
        dragging.current = null;
        pendingEdge.current = null;
        beforeBulk.current = null;
        onDrawChange.current = null;
        renderDrawing();
        showSnap(null);
        map.current?.dragPan.enable();
        const canvas = map.current?.getCanvas();
        if (canvas) canvas.style.cursor = "";
      },

      /**
       * Closes the ring and returns it, or null if it is not a polygon.
       *
       * Three points is the minimum for an area. The caller keeps the button
       * disabled below that, but the check is here too - a two-point "polygon"
       * would be stored as a footprint with no area.
       */
      finishDraw(): GeoJSON.Polygon | null {
        const points = drawing.current;
        if (points.length < 3) return null;
        const ring = [...points, points[0]];
        drawing.current = [];
        drawActive.current = false;
        appendOnClick.current = true;
        dragging.current = null;
        pendingEdge.current = null;
        beforeBulk.current = null;
        onDrawChange.current = null;
        renderDrawing();
        showSnap(null);
        map.current?.dragPan.enable();
        const canvas = map.current?.getCanvas();
        if (canvas) canvas.style.cursor = "";
        return { type: "Polygon", coordinates: [ring] };
      },

      clearSite() {
        for (const id of [
          SITE_PIN, SITE_TITLE, SITE_FOOTPRINT,
          CONSTRAINT_PRESENT, CONSTRAINT_PROXIMITY, CONSTRAINT_SEARCH,
          GRID_SUPPLY_AREA, GRID_SITE_SUBS, GRID_ECR,
          DRAW_LINE, DRAW_POINTS, DRAW_MIDS, DRAW_SNAP, DRAW_SNAP_EDGE,
          DRAW_SQUARE, DRAW_SQUARE_EXT, DRAW_CROSS, NEIGHBOURS,
        ]) {
          setSiteData(id, emptyCollection());
        }
        drawing.current = [];
        drawActive.current = false;
        onDrawChange.current = null;
        // Snap targets belong to the site that was on screen. Left in place
        // they would be invisible corners and walls from the previous building.
        neighbours.current = [];
        snapTargets.current = { vertices: [], edges: [] };
        dragging.current = null;
        pendingEdge.current = null;
        appendOnClick.current = true;
        setCoverage(null);
        setGridCoverage(null);
        gridBounds.current = null;
      },
    }),
    [setSiteData, renderDrawing],
  );

  /* S-02 layer state. `hidden` is per category; the coverage strip is what
     stops an empty map reading as an all-clear. */
  const [coverage, setCoverage] = useState<LayerCoverage | null>(null);
  const [gridCoverage, setGridCoverage] = useState<GridLayerCoverage | null>(null);
  /*
   * The S-02 fit is the ~50 m constraint envelope; the ECR radius is 2 km. One
   * frame cannot serve both - fitting the wider one makes the building a dot
   * and the constraints invisible. So the site fit wins, and the grid bounds
   * are kept here so the legend can offer to go to them.
   */
  const gridBounds = useRef<[[number, number], [number, number]] | null>(null);

  /*
   * Redraw state lives in refs, not React state: the map's click handler is
   * bound once on load and would otherwise close over a stale snapshot. The
   * panel is told the vertex count through the callback instead.
   */
  const drawing = useRef<[number, number][]>([]);
  const drawActive = useRef(false);
  const onDrawChange = useRef<((state: DrawState) => void) | null>(null);

  /*
   * Move-pin mode. Separate from draw mode and mutually exclusive with it: one
   * click cannot mean both "place a corner" and "pick a building".
   */
  /** Neighbouring polygons currently drawn, and their corners and walls. */
  const neighbours = useRef<{ geometry: GeoJSON.Geometry; label: string }[]>([]);
  const snapTargets = useRef<SnapTargets>({ vertices: [], edges: [] });
  const snapOn = useRef(true);
  /** Right-angle assist. Separate from snapping: it aligns to an assumption. */
  const squareOn = useRef(true);
  /**
   * The ring as it was before the last WHOLE-SHAPE change, so that one can be
   * taken back. One snapshot, not a stack: these are occasional, deliberate
   * operations, and a second one meaning the first is no longer undoable is
   * easier to hold in the head than a history the panel would have to show.
   */
  const beforeBulk = useRef<Vertex[] | null>(null);
  /** Index of the vertex being dragged, or null. */
  const dragging = useRef<number | null>(null);
  /**
   * A press on a wall, before it is known whether it is a drag or a click.
   * `from` is where the pointer was in lng/lat, so the wall moves by the
   * pointer's own travel rather than jumping its midpoint to the cursor.
   */
  const pendingEdge = useRef<{
    index: number;
    onMidpoint: boolean;
    from: Vertex;
    at: { x: number; y: number };
    travelled: boolean;
  } | null>(null);
  /** True in edit mode, where a click on open map must NOT append a vertex. */
  const appendOnClick = useRef(true);

  const picking = useRef(false);
  const onPick = useRef<((lat: number, lon: number) => void) | null>(null);
  const [hiddenCategories, setHiddenCategories] = useState<Set<ConstraintCategory>>(
    () => new Set(),
  );

  /*
   * Toggling a category filters the layers rather than removing data, so the
   * coverage strip keeps counting what was screened. Hiding a layer must not
   * change what the map claims was checked.
   */
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const visible = CATEGORIES.map((c) => c.key).filter((k) => !hiddenCategories.has(k));
    const filter =
      visible.length === CATEGORIES.length
        ? null
        : (["in", ["get", "category"], ["literal", visible]] as unknown as never);

    for (const id of [
      `${CONSTRAINT_PRESENT}-fill`, `${CONSTRAINT_PRESENT}-line`,
      `${CONSTRAINT_PROXIMITY}-fill`, `${CONSTRAINT_PROXIMITY}-line`,
    ]) {
      if (m.getLayer(id)) m.setFilter(id, filter);
    }
  }, [hiddenCategories, ready, styleEpoch]);

  const withHeadroom = useMemo(
    () => substations.filter((s) => s.generationHeadroomMva !== null).length,
    [substations],
  );

  /* ---- render ----------------------------------------------------------- */

  return (
    <div className="shell">
      <header className="topbar">
        <h1>Land — grid capacity</h1>
        <span className="eyebrow">Phase 1 · LTDS capacity heatmap</span>
        <span className="count">
          {substations.length} substations · {withHeadroom} with published headroom
        </span>
      </header>

      {hasSample && (
        <div className="banner">
          Showing <strong>illustrative sample data</strong>, not live DNO figures. Run{" "}
          <code>npm run grid:verify</code> then <code>npm run grid:ingest</code> to load the real
          capacity heatmap.
        </div>
      )}
      {loadError && (
        <div className="banner error">
          Could not load substations: {loadError}. Check <code>DATABASE_URL</code> and that{" "}
          <code>npm run db:migrate</code> has been run.
        </div>
      )}
      {mapError && (
        <div className="banner error">
          Base map problem: {mapError}. The substation list still works.
        </div>
      )}

      <div className="body">
        <aside className="panel">
          <SitePanel mapApi={mapApi} />

          <div className="filters">
            <div className="field">
              <label htmlFor="headroom">
                Min generation headroom <span className="val">{minHeadroom} MVA</span>
              </label>
              <input
                id="headroom"
                type="range"
                min={0}
                max={40}
                step={1}
                value={minHeadroom}
                onChange={(e) => setMinHeadroom(Number(e.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="voltage">Minimum voltage</label>
              <select
                id="voltage"
                value={minVoltage}
                onChange={(e) => setMinVoltage(Number(e.target.value))}
              >
                <option value={0}>Any voltage</option>
                <option value={11}>11 kV and above</option>
                <option value={33}>33 kV and above</option>
                <option value={66}>66 kV and above</option>
                <option value={132}>132 kV and above</option>
              </select>
            </div>
          </div>

          <div className="results">
            {substations.length === 0 && !loadError && (
              <div className="empty">
                No substations match. Loosen the filters, or seed the database with{" "}
                <code>npm run db:seed</code>.
              </div>
            )}
            {substations.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`result${selected === s.id ? " active" : ""}`}
                onClick={() => focus(s)}
              >
                <span className="name">
                  <span className={`dot ${ragClass(s.generationRag)}`} />
                  {s.name ?? s.sourceRef}
                </span>
                <span className="meta">
                  {s.dnoName}
                  {s.voltageKv ? ` · ${s.voltageKv} kV` : ""} · gen{" "}
                  {fmt(s.generationHeadroomMva, "MVA")}
                  {isStale(s.ingestedAt) && <span className="stale">stale</span>}
                </span>
                {s.constraintNote && <span className="note">{s.constraintNote}</span>}
              </button>
            ))}
          </div>

          <p className="caveat">
            Indicative only — based on published DNO data. <strong>Not a connection
            offer.</strong> A connection application to the relevant DNO is required.
            Screening flags are for review by a qualified person.
          </p>
        </aside>

        <div className="map-wrap">
          <div ref={container} className="map" aria-label="Substation capacity map" />

          {ready && (
            <div className="legend">
              <span className="eyebrow">Generation headroom</span>
              <span className="row">
                <span className="dot green" /> 10 MVA or more
              </span>
              <span className="row">
                <span className="dot amber" /> 2–10 MVA
              </span>
              <span className="row">
                <span className="dot red" /> Under 2 MVA
              </span>
              <span className="row">
                <span className="dot unknown" /> Not published
              </span>
              <span className="basemap">
                Base map: {basemapName()}
                {tilesFailed && " — tiles unavailable"}
              </span>
            </div>
          )}

          {/*
            * S-02 legend and coverage.
            *
            * Only rendered once a site has been screened, and then it is the
            * thing that stops an empty map reading as an all-clear. The
            * coverage line comes first for that reason; the toggles are below
            * it, because hiding a layer must never change what the map claims
            * was checked.
            */}
          {/*
            * S-03 grid legend. Sits under the S-02 one, and leads with what an
            * ECR entry means — the dots are the part of this map most likely
            * to be read as available capacity, which is close to the opposite
            * of what they are.
            */}
          {ready && gridCoverage && (
            <div className="g-legend">
              <span className="eyebrow">Grid (S-03)</span>
              <p className="g-coverage">{gridCoverage.statement}</p>
              <p className="g-meaning">{ECR_MEANING}</p>

              {/*
                * The map is framed on the site (the constraint envelope is
                * ~50 m, the register radius 2 km), so register entries are
                * usually outside the view. Saying so and offering to go there
                * beats leaving a reader to conclude there are none.
                */}
              {gridCoverage.ecrDrawn > 0 && (
                <button
                  type="button"
                  className="g-zoom"
                  onClick={() => {
                    if (gridBounds.current) {
                      map.current?.fitBounds(gridBounds.current, {
                        padding: 70,
                        maxZoom: 16,
                        duration: 600,
                      });
                    }
                  }}
                >
                  Zoom to the {gridCoverage.ecrDrawn} register{" "}
                  {gridCoverage.ecrDrawn === 1 ? "entry" : "entries"} — most sit
                  outside this view
                </button>
              )}

              <details className="g-keys">
                <summary>Key</summary>
                <div className="g-techs">
                  {TECHNOLOGIES.filter((t) => t.key !== "unknown").map((t) => (
                    <span key={t.key} className="g-tech">
                      <span className="g-swatch" style={{ background: t.color }} />
                      {t.label}
                    </span>
                  ))}
                </div>

                <span className="row g-key">
                  <span className="g-dot connected" /> Connected — generating
                </span>
                <span className="row g-key">
                  <span className="g-dot accepted" /> Accepted — not yet connected
                </span>
                <span className="row g-key">
                  <span className="g-ring" /> Substation used for this screening
                </span>
                <span className="g-note">Dot size is export capacity.</span>
              </details>
            </div>
          )}

          {ready && coverage && (
            <div className="c-legend">
              <span className="eyebrow">Planning &amp; environmental (S-02)</span>

              <p
                className={`c-coverage ${coverage.couldNotCheck ? "gap" : ""}`}
              >
                {coverage.statement}
              </p>

              {coverage.couldNotCheckDatasets.length > 0 && (
                <details className="c-gap-list">
                  <summary>
                    Name the {coverage.couldNotCheckDatasets.length} not established
                  </summary>
                  <p className="c-gaps">{coverage.couldNotCheckDatasets.join(", ")}</p>
                </details>
              )}

              {coverage.flaggedWithoutGeometry > 0 && (
                <p className="c-gaps">
                  {coverage.flaggedWithoutGeometry} flagged constraint
                  {coverage.flaggedWithoutGeometry === 1 ? "" : "s"} published no
                  extent, so {coverage.flaggedWithoutGeometry === 1 ? "it is" : "they are"}{" "}
                  in the panel but not on the map.
                </p>
              )}

              <div className="c-cats">
                {CATEGORIES.map((c) => {
                  const off = hiddenCategories.has(c.key);
                  return (
                    <button
                      key={c.key}
                      type="button"
                      className={`c-cat ${off ? "off" : ""}`}
                      aria-pressed={!off}
                      onClick={() =>
                        setHiddenCategories((prev) => {
                          const next = new Set(prev);
                          if (next.has(c.key)) next.delete(c.key);
                          else next.add(c.key);
                          return next;
                        })
                      }
                    >
                      <span className="c-swatch" style={{ background: c.color }} />
                      {c.label}
                    </button>
                  );
                })}
              </div>

              {/* Solid vs dashed is the load-bearing distinction on this map. */}
              <details className="c-keys">
                <summary>Key</summary>
                <span className="row c-key">
                  <span className="c-sample present" /> On the site
                </span>
                <span className="row c-key">
                  <span className="c-sample proximity" /> Nearby, not on it
                </span>
                <span className="row c-key">
                  <span className="c-sample search" /> Area searched (a bounding box,
                  so its corners reach further than the buffer)
                </span>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
