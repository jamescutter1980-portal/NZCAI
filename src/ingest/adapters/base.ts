/**
 * The common DNO interface from brief §5.2.
 *
 * The brief specifies a Python Protocol in `grid/base.py`. This is the same
 * contract in TypeScript, because the build is Next.js (PLAN §3.1, TICKET-08);
 * the shape is deliberately identical so a port is mechanical.
 *
 * WHY AN INTERFACE AT ALL, GIVEN OFGEM STANDARDISED THE HEATMAP. The LTDS
 * direction standardised the information model, not the delivery: five DNOs
 * publish through Opendatasoft and NGED through CKAN, the slugs differ, and
 * some publish a supply-area polygon while others publish only points. The
 * interface is where that variation stops.
 *
 * `null` means "this DNO does not publish it", which is distinct from an empty
 * list meaning "published, and there is nothing here". Callers must be able to
 * tell those apart - it is the difference between `not_supported` and
 * `not_found_coverage_complete`.
 */

import type { AreaGeometry } from "@/lib/geo-polygon";
import type { DatasetRef, DnoEntry } from "../registry";

export interface Point {
  lat: number;
  lng: number;
}

export type SubstationLevel = "GSP" | "BSP" | "primary" | "secondary";

export interface AdapterSubstation {
  sourceRef: string;
  name: string | null;
  level: SubstationLevel | null;
  /** 'stated' when the source names the level; never claim more. */
  levelSource: "stated" | "derived_from_voltage" | "unknown";
  voltageKv: number | null;
  lat: number | null;
  lng: number | null;
  demandHeadroomMva: number | null;
  generationHeadroomMva: number | null;
  /** The DNO's own RAG where it publishes one. Ours is only a fallback. */
  demandRag: string | null;
  generationRag: string | null;
  constraintNote: string | null;
  /** The publisher's date, not our fetch date. */
  sourceDate: string | null;
  /** The supply area, where this DNO publishes one. */
  areaGeom: AreaGeometry | null;
}

export interface AdapterEcrEntry {
  sourceRef: string | null;
  siteName: string | null;
  technology: string | null;
  status: "connected" | "accepted" | "unknown";
  exportMva: number | null;
  importMva: number | null;
  connectionVoltageKv: number | null;
  substationName: string | null;
  lat: number | null;
  lng: number | null;
  sourceDate: string | null;
}

export interface DatasetProbe {
  slug: string;
  kind: DatasetRef["kind"];
  reachable: boolean;
  /** Field names as the portal actually publishes them. */
  fields: string[];
  recordCount: number | null;
  /** Alternative slugs when the configured one 404s. */
  suggestions: string[];
  error: string | null;
}

/**
 * One DNO's open data.
 *
 * Every method that can fail returns the failure rather than throwing, so one
 * unreachable portal does not abort a run across six.
 */
export interface DnoAdapter {
  readonly dno: DnoEntry;

  /** Resolve each configured dataset and report its real fields. */
  probe(): Promise<DatasetProbe[]>;

  /**
   * Full substation pull. Returns null when this DNO publishes no heatmap
   * dataset, as opposed to an empty array meaning it published none.
   */
  substations(): Promise<AdapterSubstation[] | null>;

  /** Full Embedded Capacity Register pull. Null when not published. */
  ecr(): Promise<AdapterEcrEntry[] | null>;
}

/**
 * Infers a substation level from voltage where the source does not state one.
 *
 * Deliberately conservative and deliberately incomplete: it returns null in the
 * overlapping ranges rather than picking. A level is a network role, and
 * voltage is only a proxy for it - the result is always recorded as
 * `derived_from_voltage` so it is never shown as the publisher's word.
 */
export function levelFromVoltage(kv: number | null): SubstationLevel | null {
  if (kv === null || !Number.isFinite(kv)) return null;
  if (kv >= 275) return "GSP";
  if (kv >= 100) return "BSP";
  if (kv >= 20 && kv <= 70) return "primary";
  if (kv < 1) return "secondary";
  return null;
}

/**
 * Normalises a register's connection status onto the brief's vocabulary.
 *
 * Anything unrecognised becomes 'unknown' rather than being forced into one of
 * the two: an entry whose status did not map is not evidence that something is
 * connected, and a summary that says so is more useful than a tidy one.
 */
export function normaliseEcrStatus(raw: string | null): AdapterEcrEntry["status"] {
  if (!raw) return "unknown";
  const text = raw.toLowerCase();

  // Match the PARTICIPLE, not the stem. "Accepted to Connect" contains
  // "connect" and means the opposite of connected - it is an offer that has
  // not been energised - so a stem match reports a generator on the network
  // that is not there yet, which is exactly the wrong direction for a
  // headroom screen.
  if (/\bconnected\b/.test(text) && !/\b(not|pre|to be|due to)\b[^.]*\bconnected\b/.test(text)) {
    return "connected";
  }
  if (/accept|offer|contract|agreed|energis/.test(text)) return "accepted";
  return "unknown";
}
