/**
 * S-03 grid screening. Brief §5.4, deterministic, thresholds from
 * `grid_rules.yaml`.
 *
 * FOUR THINGS THE BRIEF ASKS FOR THAT THE SHAPE HERE ENFORCES.
 *
 * 1. A CONTAINING POLYGON BEATS PROXIMITY, and when there is no polygon the
 *    result is LABELLED `nearest_by_distance`. The nearest substation to a site
 *    is not necessarily the one that would serve it - licence areas and network
 *    topology do not follow straight lines - so the label has to survive into
 *    the output rather than being a note in the code.
 *
 * 2. UNRATED IS A FOURTH STATE, not a missing green. A screen with no input is
 *    "not assessed", and the wording says so. Collapsing unrated into green is
 *    the single most dangerous simplification available here, because a screen
 *    is read as a permission.
 *
 * 3. STALENESS IS MEASURED AGAINST THE DNO'S PUBLISHED DATE, not our ingest
 *    date, falling back to ingest only when the publisher states none. Fetching
 *    old data today does not make it fresh.
 *
 * 4. THE FIXED WORDING TRAVELS WITH THE FIGURES. It is in the YAML, rendered
 *    into every result, and not optional.
 *
 * Headroom throughout is NETWORK capacity in MVA. It is not a site's agreed
 * supply capacity in kVA, which is per-MPAN and commercially held.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

import type { Rag } from "@/lib/types";
import type { Tier } from "./types";

/* ----------------------------------------------------------------- rules --- */

export interface GridRules {
  meta: { source: string; approved: boolean };
  staleness: { stale_after_days: number; note: string; approved: boolean };
  ecr: { radius_m: number; min_export_kw: number; note: string; approved: boolean };
  proximity: { nearest_count: number; radius_m: number; note: string; approved: boolean };
  rag_bands: {
    generation: { green_mva: number; amber_mva: number };
    demand: { green_mva: number; amber_mva: number };
    note: string;
    approved: boolean;
  };
  screens: Record<
    "pv_export" | "electrification",
    { green_max_fraction: number; amber_max_fraction: number; note: string; approved: boolean }
  >;
  connection_thresholds: {
    verified: boolean;
    source: string;
    g98_max_kw_per_phase: number | null;
    g99_applies_above: number | null;
    note: string;
    approved: boolean;
  };
  wording: {
    fixed_caveat: string;
    network_vs_site: string;
    nearest_by_distance: string;
    stale: string;
    unrated: string;
    approved: boolean;
  };
}

let cache: GridRules | null = null;

export function loadGridRules(): GridRules {
  if (cache) return cache;
  const path = join(process.cwd(), "src", "lib", "site-intel", "grid_rules.yaml");
  const parsed = parse(readFileSync(path, "utf8")) as GridRules;
  if (!parsed?.staleness || !parsed.screens || !parsed.wording) {
    throw new Error("grid_rules.yaml: missing `staleness`, `screens` or `wording`");
  }
  cache = parsed;
  return cache;
}

/** Rule blocks James has not signed off. Surfaced by `npm run grid:verify`. */
export function unapprovedGridRules(): string[] {
  const rules = loadGridRules() as unknown as Record<string, { approved?: boolean }>;
  const keys: string[] = [];
  for (const [key, block] of Object.entries(rules)) {
    if (block && typeof block === "object" && block.approved === false) keys.push(key);
  }
  for (const [key, block] of Object.entries(loadGridRules().screens)) {
    if (!block.approved) keys.push(`screens.${key}`);
  }
  return keys;
}

function render(text: string, values: Record<string, string | number> = {}): string {
  let out = text;
  for (const [key, value] of Object.entries(values)) {
    out = out.replaceAll(`{${key}}`, String(value));
  }
  return out.replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ RAG --- */

export function ragFor(
  headroomMva: number | null,
  bands: { green_mva: number; amber_mva: number },
): Rag | null {
  if (headroomMva === null || !Number.isFinite(headroomMva)) return null;
  if (headroomMva >= bands.green_mva) return "green";
  if (headroomMva >= bands.amber_mva) return "amber";
  return "red";
}

/* ------------------------------------------------------------ staleness --- */

export interface Freshness {
  /** The date the assessment is made against, and where it came from. */
  asOf: string | null;
  basis: "published" | "ingested" | "unknown";
  ageDays: number | null;
  stale: boolean;
  tier: Tier;
  warning: string | null;
}

/**
 * `sourceDate` is what the DNO published; `ingestedAt` is when we fetched it.
 * They are not interchangeable and the brief's 90-day rule is about the first.
 */
export function freshness(
  sourceDate: string | null,
  ingestedAt: string | null,
  now: Date = new Date(),
): Freshness {
  const rules = loadGridRules();
  const limit = rules.staleness.stale_after_days;

  const basis: Freshness["basis"] = sourceDate ? "published" : ingestedAt ? "ingested" : "unknown";
  const asOf = sourceDate ?? ingestedAt;
  if (!asOf) {
    return {
      asOf: null,
      basis: "unknown",
      ageDays: null,
      stale: false,
      tier: "T3",
      warning:
        "Neither the publisher's date nor an ingest date is recorded, so the age of this figure is unknown.",
    };
  }

  const when = new Date(asOf);
  if (Number.isNaN(when.getTime())) {
    return { asOf, basis, ageDays: null, stale: false, tier: "T3", warning: `"${asOf}" is not a readable date.` };
  }

  const ageDays = Math.floor((now.getTime() - when.getTime()) / 86_400_000);
  const stale = ageDays > limit;

  return {
    asOf: when.toISOString().slice(0, 10),
    basis,
    ageDays,
    stale,
    tier: stale ? "stale" : "T2",
    warning: stale ? render(rules.wording.stale, { days: limit }) : null,
  };
}

/* -------------------------------------------------------------- screens --- */

export type ScreenResult = Rag | "unrated";

export interface Screen {
  key: "pv_export" | "electrification";
  result: ScreenResult;
  /** The headroom the comparison used, MVA. */
  headroomMva: number | null;
  /** The load or export compared against it, MVA. Null leaves it unrated. */
  proposedMva: number | null;
  fraction: number | null;
  explanation: string;
}

/**
 * Compares a proposed figure against published headroom.
 *
 * Returns `unrated` whenever either side is missing. The brief requires this
 * and the wording spells out that unrated is an absence of assessment - a
 * screen with no input must never read as a pass.
 */
export function screen(
  key: Screen["key"],
  headroomMva: number | null,
  proposedMva: number | null,
): Screen {
  const rules = loadGridRules();
  const band = rules.screens[key];

  if (headroomMva === null || proposedMva === null || !Number.isFinite(proposedMva)) {
    return {
      key,
      result: "unrated",
      headroomMva,
      proposedMva,
      explanation:
        render(rules.wording.unrated) +
        " " +
        (proposedMva === null
          ? key === "pv_export"
            ? "No proposed export capacity has been supplied."
            : "No estimated added load has been supplied."
          : "No published headroom is available for this substation."),
      fraction: null,
    };
  }

  // No headroom at all cannot absorb anything, and dividing by it would say
  // Infinity rather than "red".
  if (headroomMva <= 0) {
    return {
      key,
      result: "red",
      headroomMva,
      proposedMva,
      fraction: null,
      explanation:
        `The published headroom is ${headroomMva} MVA, so none of the proposed ` +
        `${proposedMva} MVA is covered by it.`,
    };
  }

  const fraction = proposedMva / headroomMva;
  const result: Rag =
    fraction <= band.green_max_fraction ? "green"
    : fraction <= band.amber_max_fraction ? "amber"
    : "red";

  return {
    key,
    result,
    headroomMva,
    proposedMva,
    fraction: Math.round(fraction * 1000) / 10,
    explanation:
      `${proposedMva} MVA against ${headroomMva} MVA of published headroom is ` +
      `${Math.round(fraction * 1000) / 10}% of it.`,
  };
}

/* ------------------------------------------------------------------ ECR --- */

export interface EcrEntry {
  sourceRef: string | null;
  siteName: string | null;
  technology: string | null;
  status: "connected" | "accepted" | "unknown";
  exportMva: number | null;
  importMva: number | null;
  lat: number | null;
  lng: number | null;
  distanceM: number | null;
  sourceDate: string | null;
}

export interface EcrSummary {
  radiusM: number;
  minExportKw: number;
  entries: EcrEntry[];
  /** Totals by technology, then by status. Both, because both are asked. */
  byTechnology: { technology: string; count: number; exportMva: number }[];
  byStatus: { status: string; count: number; exportMva: number }[];
  totalExportMva: number;
  note: string;
}

export function summariseEcr(entries: EcrEntry[]): EcrSummary {
  const rules = loadGridRules();

  const tech = new Map<string, { count: number; exportMva: number }>();
  const status = new Map<string, { count: number; exportMva: number }>();
  let total = 0;

  for (const e of entries) {
    const mva = e.exportMva ?? 0;
    total += mva;

    // "unknown" is kept as its own bucket rather than folded into a named
    // technology: a register entry whose technology did not map is not
    // evidence about solar, wind or anything else.
    const t = e.technology ?? "unknown";
    const tEntry = tech.get(t) ?? { count: 0, exportMva: 0 };
    tech.set(t, { count: tEntry.count + 1, exportMva: tEntry.exportMva + mva });

    const sEntry = status.get(e.status) ?? { count: 0, exportMva: 0 };
    status.set(e.status, { count: sEntry.count + 1, exportMva: sEntry.exportMva + mva });
  }

  const round = (n: number): number => Math.round(n * 1000) / 1000;

  return {
    radiusM: rules.ecr.radius_m,
    minExportKw: rules.ecr.min_export_kw,
    entries,
    byTechnology: [...tech.entries()]
      .map(([technology, v]) => ({ technology, count: v.count, exportMva: round(v.exportMva) }))
      .sort((a, b) => b.exportMva - a.exportMva),
    byStatus: [...status.entries()]
      .map(([s, v]) => ({ status: s, count: v.count, exportMva: round(v.exportMva) }))
      .sort((a, b) => b.exportMva - a.exportMva),
    totalExportMva: round(total),
    note: render(rules.ecr.note),
  };
}

/* -------------------------------------------------------------- wording --- */

/** Brief §5.4 step 4. Fixed, from the YAML, on every grid output. */
export function fixedCaveat(dnoName: string | null, sourceDate: string | null): string {
  const rules = loadGridRules();
  const date = sourceDate
    ? new Date(sourceDate).toLocaleDateString("en-GB")
    : "an unstated date";
  return render(rules.wording.fixed_caveat, {
    date,
    dno: dnoName ?? "the relevant DNO",
  });
}

export function networkVsSiteNote(): string {
  return render(loadGridRules().wording.network_vs_site);
}

export function nearestByDistanceNote(): string {
  return render(loadGridRules().wording.nearest_by_distance);
}
