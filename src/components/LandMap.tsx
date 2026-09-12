"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader } from "@googlemaps/js-api-loader";
import { RAG_COLOR } from "@/lib/headroom";
import { gridCaveat, isStale } from "@/lib/grid";
import type { Rag, Substation } from "@/lib/types";

const GB_CENTRE = { lat: 53.2, lng: -2.0 };
const GB_ZOOM = 6;

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

export default function LandMap() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapObj = useRef<google.maps.Map | null>(null);
  const markers = useRef<Map<number, google.maps.Marker>>(new Map());
  const infoWindow = useRef<google.maps.InfoWindow | null>(null);

  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [substations, setSubstations] = useState<Substation[]>([]);
  const [hasSample, setHasSample] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [minHeadroom, setMinHeadroom] = useState(0);
  const [minVoltage, setMinVoltage] = useState(0);

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID;

  /* ---- fetch ------------------------------------------------------------ */

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "2000" });
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

  useEffect(() => {
    void load();
  }, [load]);

  /* ---- map init --------------------------------------------------------- */

  useEffect(() => {
    if (!apiKey || !mapRef.current || mapObj.current) return;

    let cancelled = false;
    const loader = new Loader({ apiKey, version: "weekly" });

    loader
      .importLibrary("maps")
      .then(({ Map, InfoWindow }) => {
        if (cancelled || !mapRef.current) return;
        mapObj.current = new Map(mapRef.current, {
          center: GB_CENTRE,
          zoom: GB_ZOOM,
          mapTypeId: "hybrid",
          mapTypeControl: true,
          streetViewControl: false,
          fullscreenControl: false,
          ...(mapId ? { mapId } : {}),
        });
        infoWindow.current = new InfoWindow();
        setReady(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setMapError(err instanceof Error ? err.message : "Google Maps failed to load");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [apiKey, mapId]);

  /* ---- markers ---------------------------------------------------------- */

  useEffect(() => {
    const map = mapObj.current;
    if (!ready || !map) return;

    const seen = new Set<number>();

    for (const s of substations) {
      if (s.lat === null || s.lng === null) continue;
      seen.add(s.id);

      const colour = RAG_COLOR[ragClass(s.generationRag) as keyof typeof RAG_COLOR];
      let marker = markers.current.get(s.id);

      if (!marker) {
        marker = new google.maps.Marker({
          position: { lat: s.lat, lng: s.lng },
          map,
          title: s.name ?? s.sourceRef,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 7,
            fillColor: colour,
            fillOpacity: 0.95,
            strokeColor: "#ffffff",
            strokeWeight: 1.5,
          },
        });
        marker.addListener("click", () => {
          setSelected(s.id);
          infoWindow.current?.setContent(
            `<div style="font-family:system-ui;font-size:13px;line-height:1.5">
               <strong>${s.name ?? s.sourceRef}</strong><br>
               ${s.dnoName}${s.voltageKv ? ` · ${s.voltageKv} kV` : ""}<br>
               Generation headroom: <strong>${fmt(s.generationHeadroomMva, "MVA")}</strong><br>
               Demand headroom: ${fmt(s.demandHeadroomMva, "MVA")}
               ${s.constraintNote ? `<br><em>${s.constraintNote}</em>` : ""}
               <div style="margin-top:8px;padding-top:7px;border-top:1px solid #ddd;font-size:11.5px;color:#555">
                 ${gridCaveat(s.dnoName, s.ingestedAt)}
               </div>
             </div>`,
          );
          infoWindow.current?.open({ map, anchor: marker });
        });
        markers.current.set(s.id, marker);
      } else {
        marker.setIcon({
          path: google.maps.SymbolPath.CIRCLE,
          scale: 7,
          fillColor: colour,
          fillOpacity: 0.95,
          strokeColor: "#ffffff",
          strokeWeight: 1.5,
        });
        marker.setMap(map);
      }
    }

    // Drop markers filtered out of the current result set.
    for (const [id, marker] of markers.current) {
      if (!seen.has(id)) {
        marker.setMap(null);
        markers.current.delete(id);
      }
    }
  }, [ready, substations]);

  const focus = useCallback((s: Substation) => {
    setSelected(s.id);
    const map = mapObj.current;
    if (!map || s.lat === null || s.lng === null) return;
    map.panTo({ lat: s.lat, lng: s.lng });
    if ((map.getZoom() ?? 0) < 11) map.setZoom(11);
    const marker = markers.current.get(s.id);
    if (marker) google.maps.event.trigger(marker, "click");
  }, []);

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

      <div className="body">
        <aside className="panel">
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
              <div style={{ padding: "18px", color: "var(--ink-3)", fontSize: 14 }}>
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
          {!apiKey ? (
            <div className="placeholder">
              <h2>Google Maps key not set</h2>
              <p>
                Add <code>NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> to <code>.env</code> and restart
                the dev server. The substation list on the left works without it.
              </p>
            </div>
          ) : mapError ? (
            <div className="placeholder">
              <h2>Map failed to load</h2>
              <p>{mapError}</p>
              <p>
                Usually the key is missing the Maps JavaScript API, or the referrer restriction
                excludes <code>localhost</code>.
              </p>
            </div>
          ) : null}

          <div ref={mapRef} className="map" aria-label="Substation capacity map" />

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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
