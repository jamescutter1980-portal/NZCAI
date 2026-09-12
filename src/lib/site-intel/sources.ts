import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { SourceRecord, Tier } from "./types";

/**
 * Loader for sources.yaml. Attribution strings live in the YAML, never in
 * code, so they can be corrected against the licence pages without a deploy.
 */

export interface SourceDef {
  name: string;
  publisher: string;
  dataset: string;
  kind: "api" | "bulk";
  url: string;
  licence: string;
  licence_url: string;
  attribution: string;
  /** False until someone has checked the string against the licence page. */
  attribution_verified: boolean;
  refresh: string;
  coverage?: string;
  persist_coordinates?: boolean;
  notes?: string;
}

interface SourcesFile {
  sources: Record<string, SourceDef>;
}

let cache: Record<string, SourceDef> | null = null;

export function loadSources(): Record<string, SourceDef> {
  if (cache) return cache;
  const path = join(process.cwd(), "src", "lib", "site-intel", "sources.yaml");
  const parsed = parse(readFileSync(path, "utf8")) as SourcesFile;
  if (!parsed?.sources || typeof parsed.sources !== "object") {
    throw new Error("sources.yaml: missing top-level `sources` map");
  }
  cache = parsed.sources;
  return cache;
}

export function getSource(id: string): SourceDef {
  const source = loadSources()[id];
  if (!source) {
    // Fail loudly: a missing source means missing attribution, and attribution
    // is a licence condition rather than a nicety.
    throw new Error(`Unknown source id "${id}" - add it to sources.yaml`);
  }
  return source;
}

/** Substitutes {year}. Collapses the whitespace YAML block scalars introduce. */
export function renderAttribution(id: string, year = new Date().getFullYear()): string {
  return getSource(id)
    .attribution.replaceAll("{year}", String(year))
    .replace(/\s+/g, " ")
    .trim();
}

/** Every attribution that must be shown for a set of sources, deduplicated. */
export function attributionsFor(sourceIds: string[]): string[] {
  const seen = new Set<string>();
  for (const id of sourceIds) seen.add(renderAttribution(id));
  return [...seen];
}

/** Source ids whose attribution has not been checked against the licence page. */
export function unverifiedAttributions(): string[] {
  return Object.entries(loadSources())
    .filter(([, def]) => !def.attribution_verified)
    .map(([id]) => id);
}

export interface LineageInput {
  sourceId: string;
  entityRef?: string | null;
  method: string;
  tier: Tier;
  sourceUpdated?: string | null;
  retrievedAt?: string;
}

/** Builds a SourceRecord, pulling licence and attribution from the YAML. */
export function lineage(input: LineageInput): SourceRecord {
  const def = getSource(input.sourceId);
  return {
    sourceId: input.sourceId,
    dataset: def.dataset,
    entityRef: input.entityRef ?? null,
    licence: def.licence,
    attribution: renderAttribution(input.sourceId),
    retrievedAt: input.retrievedAt ?? new Date().toISOString(),
    sourceUpdated: input.sourceUpdated ?? null,
    method: input.method,
    tier: input.tier,
  };
}

/** Refresh cadences are "7d", "30d", "quarterly", "none". Returns days or null. */
export function ttlDays(id: string): number | null {
  const refresh = getSource(id).refresh;
  const match = /^(\d+)d$/.exec(refresh);
  if (match) return Number(match[1]);
  if (refresh === "quarterly") return 90;
  if (refresh === "biannual") return 182;
  return null;
}

/** A record past its source's TTL is downgraded to the stale tier. */
export function applyStaleness(record: SourceRecord, now = Date.now()): SourceRecord {
  const days = ttlDays(record.sourceId);
  if (days === null || record.tier === "T4") return record;
  const ageDays = (now - new Date(record.retrievedAt).getTime()) / 86_400_000;
  return ageDays > days ? { ...record, tier: "stale" } : record;
}
