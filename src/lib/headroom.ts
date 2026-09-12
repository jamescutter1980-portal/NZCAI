import type { Rag } from "./types";

/**
 * Headroom bands, in MVA, for generation export screening.
 *
 * These are OUR screening defaults, not a regulated classification. DNOs
 * publish their own RAG ratings against their own thresholds; where a
 * published rating exists the ingest keeps it and these bands are not used.
 *
 * Calibrated against typical distribution-connected solar: a 10 MVA+ headroom
 * comfortably takes a mid-size ground-mount scheme, 2-10 MVA suits a small
 * scheme or a large rooftop array, below 2 MVA is rooftop territory at best.
 * Revisit once we have real acceptance rates to score against.
 */
export const GENERATION_BANDS = { green: 10, amber: 2 } as const;
export const DEMAND_BANDS = { green: 10, amber: 2 } as const;

export function ragFromHeadroom(
  headroomMva: number | null | undefined,
  bands: { green: number; amber: number },
): Rag | null {
  if (headroomMva === null || headroomMva === undefined || Number.isNaN(headroomMva)) {
    return null;
  }
  if (headroomMva >= bands.green) return "green";
  if (headroomMva >= bands.amber) return "amber";
  return "red";
}

export function ragLabel(rag: Rag | null): string {
  if (rag === "green") return "Good headroom";
  if (rag === "amber") return "Limited headroom";
  if (rag === "red") return "Constrained";
  return "Not published";
}

/** Marker fill per RAG band. Kept in one place so map and list agree. */
export const RAG_COLOR: Record<Rag | "unknown", string> = {
  green: "#1C6647",
  amber: "#B07C0C",
  red: "#A32F24",
  unknown: "#77828D",
};
