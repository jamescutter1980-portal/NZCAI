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

const GB_CENTRE: [number, number] = [-2.0, 53.2];
const GB_ZOOM = 5.2;
const SOURCE_ID = "substations";
const LAYER_ID = "substation-circles";
const SITE_PIN = "site-pin";
const SITE_TITLE = "site-title";
const SITE_FOOTPRINT = "site-footprint";

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

function emptyCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function featureOf(geometry: GeoJSON.Geometry | null): GeoJSON.FeatureCollection {
  return geometry
    ? { type: "FeatureCollection", features: [{ type: "Feature", geometry, properties: {} }] }
    : emptyCollection();
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

    instance.on("click", LAYER_ID, (e: MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
        const id = e.features?.[0]?.properties?.id as number | undefined;
        if (id === undefined) return;
        const s = byId.current.get(Number(id));
        if (s) {
          setSelected(s.id);
          openPopup(s);
        }
      });

    instance.on("mouseenter", LAYER_ID, () => {
      instance.getCanvas().style.cursor = "pointer";
    });
    instance.on("mouseleave", LAYER_ID, () => {
      instance.getCanvas().style.cursor = "";
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

  const setSiteData = useCallback((id: string, data: GeoJSON.FeatureCollection) => {
    const source = map.current?.getSource(id) as GeoJSONSource | undefined;
    source?.setData(data);
  }, []);

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
      clearSite() {
        for (const id of [SITE_PIN, SITE_TITLE, SITE_FOOTPRINT]) {
          setSiteData(id, emptyCollection());
        }
      },
    }),
    [setSiteData],
  );

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
        </div>
      </div>
    </div>
  );
}
