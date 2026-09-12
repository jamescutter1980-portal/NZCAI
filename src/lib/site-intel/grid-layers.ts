/**
 * S-03 map layers: how grid features are grouped and coloured.
 *
 * Presentational only, and a leaf module — no imports, no I/O — so the map can
 * use it without pulling the rules loader and `node:fs` into the browser
 * bundle. Same shape as `constraint-layers.ts` for S-02.
 *
 * THE THING THIS LAYER MUST NOT IMPLY. An Embedded Capacity Register entry is
 * generation that is ALREADY CONNECTED OR ACCEPTED. Drawn as dots around a
 * site it invites two wrong readings: "there is capacity here" and "others got
 * connected, so I can". It is evidence of what the network has ABSORBED, which
 * is closer to the opposite of both. The legend says so in as many words, and
 * `ECR_MEANING` below is the single place that sentence lives.
 */

export const ECR_MEANING =
  "These are generators already connected or accepted for connection. They show " +
  "what the network has absorbed, not what is left — a cluster is not evidence " +
  "of available capacity.";

/* ---------------------------------------------------------- technologies --- */

export type Technology =
  | "solar"
  | "wind"
  | "storage"
  | "engine"
  | "biomass"
  | "hydro"
  | "other"
  | "unknown";

export interface TechnologySpec {
  key: Technology;
  label: string;
  color: string;
}

export const TECHNOLOGIES: readonly TechnologySpec[] = [
  { key: "solar", label: "Solar", color: "#C08A1E" },
  { key: "wind", label: "Wind", color: "#2E7DA8" },
  { key: "storage", label: "Storage", color: "#6B5B95" },
  { key: "engine", label: "Gas / diesel engine", color: "#A32F24" },
  { key: "biomass", label: "Biomass / EfW", color: "#3D7A3D" },
  { key: "hydro", label: "Hydro", color: "#1C6647" },
  { key: "other", label: "Other", color: "#78838E" },
  { key: "unknown", label: "Not stated", color: "#A8B0B8" },
] as const;

/**
 * Normalises the register's free-text technology.
 *
 * Order matters where a string names more than one thing. "Solar PV with
 * battery storage" is a solar connection with storage attached, and for siting
 * PV the solar is the salient fact, so solar is tested first.
 *
 * Anything unrecognised becomes `other`, and an absent value becomes
 * `unknown`. Those are different: "the register said something we do not
 * recognise" is not "the register said nothing".
 */
export function technologyOf(raw: string | null): Technology {
  if (!raw || !raw.trim()) return "unknown";
  const text = raw.toLowerCase();

  if (/solar|photovolt|\bpv\b/.test(text)) return "solar";
  if (/wind/.test(text)) return "wind";
  if (/batter|storage|\bbess\b/.test(text)) return "storage";
  if (/hydro(?!gen)/.test(text)) return "hydro";
  if (/biomass|biogas|anaerobic|landfill|energy from waste|\befw\b|\bad\b/.test(text)) {
    return "biomass";
  }
  if (/diesel|reciprocat|\bchp\b|gas engine|combined heat/.test(text)) return "engine";
  return "other";
}

export function technologySpec(key: Technology): TechnologySpec {
  const spec = TECHNOLOGIES.find((t) => t.key === key);
  if (!spec) throw new Error(`unknown technology "${key}"`);
  return spec;
}

export function technologyColor(raw: string | null): string {
  return technologySpec(technologyOf(raw)).color;
}

/* ---------------------------------------------------------------- status --- */

/**
 * Connected and accepted are drawn differently, for the same reason `present`
 * and `proximity` are in S-02: an accepted connection is not generating yet,
 * and a map that shows them identically states something false about the
 * network as it stands today.
 */
export const STATUS_LABEL: Record<string, string> = {
  connected: "Connected — generating",
  accepted: "Accepted — not yet connected",
  unknown: "Status not stated",
};

/* -------------------------------------------------------------- coverage --- */

export interface GridLayerCoverage {
  substationsDrawn: number;
  /** Returned for the site but with no published coordinates. */
  substationsWithoutPoint: number;
  supplyAreasDrawn: number;
  ecrDrawn: number;
  ecrWithoutPoint: number;
  /** True when the substations came from proximity rather than containment. */
  nearestByDistance: boolean;
  /** Any substation older than the staleness window. */
  anyStale: boolean;
  statement: string;
}

export interface GridCoverageInput {
  substations: { lat: number | null; lng: number | null; stale: boolean; hasArea: boolean }[];
  ecr: { lat: number | null; lng: number | null }[];
  method: "supply_area" | "nearest_by_distance" | null;
  /**
   * Rows the publisher left without coordinates, counted separately.
   *
   * A radius query filters on coordinates, so these can never appear in the
   * lists above - deriving the count from them would produce a number that is
   * structurally always zero.
   */
  unplaceable?: { substations: number; ecr: number };
}

export function summariseGridLayers(input: GridCoverageInput): GridLayerCoverage {
  const substationsDrawn = input.substations.filter((s) => s.lat !== null && s.lng !== null).length;
  const supplyAreasDrawn = input.substations.filter((s) => s.hasArea).length;
  const ecrDrawn = input.ecr.filter((e) => e.lat !== null && e.lng !== null).length;

  const substationsWithoutPoint =
    (input.unplaceable?.substations ?? 0) + (input.substations.length - substationsDrawn);
  const ecrWithoutPoint =
    (input.unplaceable?.ecr ?? 0) + (input.ecr.length - ecrDrawn);
  const anyStale = input.substations.some((s) => s.stale);

  const parts: string[] = [];
  parts.push(
    substationsDrawn === 0
      ? "No substation drawn"
      : `${substationsDrawn} substation${substationsDrawn === 1 ? "" : "s"}`,
  );
  if (supplyAreasDrawn) {
    parts.push(`${supplyAreasDrawn} supply area${supplyAreasDrawn === 1 ? "" : "s"}`);
  }
  parts.push(
    ecrDrawn === 0
      ? "no register entries in range"
      : `${ecrDrawn} register entr${ecrDrawn === 1 ? "y" : "ies"}`,
  );

  const notes: string[] = [];
  if (substationsWithoutPoint) {
    notes.push(
      `${substationsWithoutPoint} substation${substationsWithoutPoint === 1 ? "" : "s"} for this ` +
        "DNO published no coordinates and cannot be placed, so a radius search cannot see them",
    );
  }
  if (ecrWithoutPoint) {
    notes.push(
      `${ecrWithoutPoint} register entr${ecrWithoutPoint === 1 ? "y" : "ies"} for this DNO ` +
        "published no coordinates and cannot be placed",
    );
  }
  if (input.method === "nearest_by_distance") {
    notes.push(
      "no supply-area polygon is published for this site, so these substations are the " +
        "nearest by straight line — proximity does not mean one would serve it",
    );
  }
  if (anyStale) notes.push("some figures are past the staleness window");

  return {
    substationsDrawn,
    substationsWithoutPoint,
    supplyAreasDrawn,
    ecrDrawn,
    ecrWithoutPoint,
    nearestByDistance: input.method === "nearest_by_distance",
    anyStale,
    statement: parts.join(" · ") + (notes.length ? ` — ${notes.join("; ")}.` : "."),
  };
}
