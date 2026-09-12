"use client";

import { useMemo, useRef, useState } from "react";

export interface PathwayPoint {
  year: number;
  pathwayValue: number | null;
  assetValue: number | null;
}

/**
 * CRREM alignment: the asset's intensity held constant against the decarbonisation
 * pathway, with the year they cross marked. Two series, so a legend is always
 * shown and both lines are labelled at their ends; colour is never the only cue.
 */
export function CrremChart({
  points,
  unit,
  misalignmentYear,
  height = 260,
}: {
  points: PathwayPoint[];
  unit: string;
  misalignmentYear: number | null;
  height?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ x: number; point: PathwayPoint } | null>(null);

  const usable = points.filter((p) => p.pathwayValue !== null || p.assetValue !== null);
  const geom = useMemo(() => {
    const width = 720;
    const pad = { top: 16, right: 88, bottom: 32, left: 56 };
    const years = usable.map((p) => p.year);
    const values = usable.flatMap((p) => [p.pathwayValue, p.assetValue].filter((v): v is number => v !== null));
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    const maxValue = Math.max(...values, 0);
    const x = (year: number) => pad.left + ((year - minYear) / Math.max(1, maxYear - minYear)) * (width - pad.left - pad.right);
    const y = (value: number) => height - pad.bottom - (value / (maxValue || 1)) * (height - pad.top - pad.bottom);
    return { width, pad, minYear, maxYear, maxValue, x, y };
  }, [usable, height]);

  if (usable.length < 2) return null;
  const { width, pad, minYear, maxYear, maxValue, x, y } = geom;

  const path = (key: "pathwayValue" | "assetValue") =>
    usable
      .filter((p) => p[key] !== null)
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.year).toFixed(1)},${y(p[key] as number).toFixed(1)}`)
      .join(" ");

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => maxValue * f);
  const yearTicks = Array.from(new Set([minYear, Math.round((minYear + maxYear) / 2), maxYear]));
  const last = usable[usable.length - 1];

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const year = Math.round(minYear + ((px - pad.left) / (width - pad.left - pad.right)) * (maxYear - minYear));
    const point = usable.reduce((best, p) => (Math.abs(p.year - year) < Math.abs(best.year - year) ? p : best), usable[0]);
    setHover({ x: x(point.year), point });
  }

  return (
    <figure style={{ margin: "12px 0" }}>
      <div style={{ display: "flex", gap: 16, alignItems: "center", fontSize: 12, marginBottom: 4 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 2, background: ASSET, display: "inline-block" }} aria-hidden /> Asset, held constant
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 2, background: PATHWAY, display: "inline-block" }} aria-hidden /> CRREM pathway
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto", background: SURFACE, border: "1px solid #ddd" }}
        role="img"
        aria-label={`Asset intensity against the CRREM pathway from ${minYear} to ${maxYear}, in ${unit}.${misalignmentYear ? ` The asset exceeds the pathway from ${misalignmentYear}.` : " The asset stays within the pathway."}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="#e6e6e3" strokeWidth={1} />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill={MUTED}>{formatTick(t)}</text>
          </g>
        ))}
        {yearTicks.map((yr) => (
          <text key={yr} x={x(yr)} y={height - 10} textAnchor="middle" fontSize={11} fill={MUTED}>{yr}</text>
        ))}

        {misalignmentYear !== null && misalignmentYear >= minYear && misalignmentYear <= maxYear && (
          <g>
            <line x1={x(misalignmentYear)} x2={x(misalignmentYear)} y1={pad.top} y2={height - pad.bottom} stroke={SERIOUS} strokeWidth={1} strokeDasharray="4 3" />
            <text x={x(misalignmentYear) + 4} y={pad.top + 10} fontSize={11} fill={SERIOUS}>Stranded {misalignmentYear}</text>
          </g>
        )}

        <path d={path("pathwayValue")} fill="none" stroke={PATHWAY} strokeWidth={2} strokeLinecap="round" />
        <path d={path("assetValue")} fill="none" stroke={ASSET} strokeWidth={2} strokeLinecap="round" />

        {last.assetValue !== null && <text x={width - pad.right + 6} y={y(last.assetValue) + 4} fontSize={11} fill={TEXT}>Asset</text>}
        {last.pathwayValue !== null && <text x={width - pad.right + 6} y={y(last.pathwayValue) + 4} fontSize={11} fill={TEXT}>Pathway</text>}

        {hover && (
          <g pointerEvents="none">
            <line x1={hover.x} x2={hover.x} y1={pad.top} y2={height - pad.bottom} stroke="#b5b5b0" strokeWidth={1} />
            {hover.point.assetValue !== null && <circle cx={hover.x} cy={y(hover.point.assetValue)} r={4} fill={ASSET} stroke={SURFACE} strokeWidth={2} />}
            {hover.point.pathwayValue !== null && <circle cx={hover.x} cy={y(hover.point.pathwayValue)} r={4} fill={PATHWAY} stroke={SURFACE} strokeWidth={2} />}
          </g>
        )}
      </svg>
      {hover && (
        <div style={{ fontSize: 12, color: TEXT, marginTop: 4 }}>
          <strong>{hover.point.year}</strong> · asset {fmtValue(hover.point.assetValue)} · pathway {fmtValue(hover.point.pathwayValue)} {unit}
        </div>
      )}
      <figcaption style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
        Intensity in {unit}. The asset line is today&apos;s intensity carried forward with no modelled improvement, so the crossing year is the
        point at which the building strands if nothing is done.
      </figcaption>
    </figure>
  );
}

function formatTick(n: number): string {
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}
const fmtValue = (n: number | null) => (n === null ? "—" : formatTick(n));

// Categorical slots 1 and 2 of the validated palette; checked with the skill's validator.
const ASSET = "#2a78d6";
const PATHWAY = "#eb6834";
const SERIOUS = "#b02a37";
const SURFACE = "#fcfcfb";
const TEXT = "#0b0b0b";
const MUTED = "#52514e";
