/**
 * DNO open-data registry.
 *
 * Dataset IDs come from the Site Intelligence brief (S-03, 11 Sep 2026) and
 * supersede earlier guesses at a common `ltds-capacity-heatmap` slug. They are
 * still marked unverified until `npm run grid:verify` resolves them against
 * the live portal - the brief requires a loud failure over a silent skip.
 *
 * Ofgem's LTDS direction standardised the capacity heatmap information model
 * (first publication 29 May 2026), so FIELDS converge even where slugs differ.
 *
 * Licence rule from the brief: any dataset whose licence does not permit
 * commercial reuse is left out, logged in docs/site-intel/PLAN.md, and raised
 * with James. `licence` below is provisional until confirmed per dataset.
 */

export type DatasetKind = "heatmap" | "ecr";

export interface DatasetRef {
  kind: DatasetKind;
  /** Opendatasoft dataset_id (or CKAN name). Fix here, not in code. */
  slug: string;
  verified: boolean;
  /** SPDX-ish licence id, or "unconfirmed" until checked on the source page. */
  licence: string;
  note?: string;
}

export interface DnoEntry {
  id: string;
  name: string;
  portalHost: string;
  /** "ods" = Opendatasoft Explore v2.1. "ckan" needs its own adapter. */
  api: "ods" | "ckan";
  supported: boolean;
  /** Verbatim attribution, per the brief. Copy from the licence page. */
  attribution: string;
  datasets: DatasetRef[];
  note?: string;
}

/** Build order from the brief: NGED, UKPN, NPg, SSEN, SP ENW, SPEN. */
export const DNOS: DnoEntry[] = [
  {
    id: "nged",
    name: "National Grid Electricity Distribution",
    portalHost: "connecteddata.nationalgrid.co.uk",
    api: "ckan",
    supported: false,
    attribution: "Contains National Grid Electricity Distribution data.",
    datasets: [
      {
        kind: "heatmap",
        slug: "network-opportunity-map-headroom",
        verified: false,
        licence: "unconfirmed",
      },
      {
        kind: "ecr",
        slug: "embedded-capacity-register",
        verified: false,
        licence: "unconfirmed",
      },
    ],
    note:
      "CKAN, not Opendatasoft - needs its own adapter. First in the brief's build order, and it matters most: NGED covers the Midlands, South West and South Wales, which is where Gate 2 left solar headroom (T8/T9).",
  },
  {
    id: "ukpn",
    name: "UK Power Networks",
    portalHost: "ukpowernetworks.opendatasoft.com",
    api: "ods",
    supported: true,
    attribution:
      "Contains UK Power Networks data, licensed under the Open Government Licence v3.0.",
    datasets: [
      { kind: "heatmap", slug: "primary-substation-headroom", verified: false, licence: "OGL-UK-3.0" },
      { kind: "heatmap", slug: "grid-and-primary-sites", verified: false, licence: "OGL-UK-3.0" },
      { kind: "ecr", slug: "embedded-capacity-register", verified: false, licence: "OGL-UK-3.0" },
    ],
  },
  {
    id: "npg",
    name: "Northern Powergrid",
    portalHost: "northernpowergrid.opendatasoft.com",
    api: "ods",
    supported: true,
    attribution:
      "Contains Northern Powergrid data, licensed under the Open Government Licence v3.0.",
    datasets: [
      { kind: "heatmap", slug: "heatmapsubstationareas", verified: false, licence: "OGL-UK-3.0" },
      {
        kind: "heatmap",
        slug: "ltds-capacity-heatmap",
        verified: true,
        licence: "OGL-UK-3.0",
        note: "Ofgem-standardised heatmap; confirmed present on this portal.",
      },
      {
        kind: "ecr",
        slug: "ecr_manual_combine_test",
        verified: false,
        licence: "unconfirmed",
        note: "Combined national ECR view. Confirm before relying on it nationally.",
      },
    ],
  },
  {
    id: "ssen",
    name: "Scottish and Southern Electricity Networks",
    portalHost: "data.ssen.co.uk",
    api: "ods",
    supported: true,
    attribution:
      "Contains SSEN Distribution data, licensed under the Open Government Licence v3.0.",
    datasets: [
      { kind: "heatmap", slug: "ltds-capacity-heatmap", verified: false, licence: "unconfirmed" },
      { kind: "ecr", slug: "embedded-capacity-register", verified: false, licence: "unconfirmed" },
    ],
    note: "Custom host, Opendatasoft underneath. Confirm the API path if verify 404s.",
  },
  {
    id: "enwl",
    name: "Electricity North West",
    portalHost: "electricitynorthwest.opendatasoft.com",
    api: "ods",
    supported: true,
    attribution:
      "Contains Electricity North West data, licensed under the Open Government Licence v3.0.",
    datasets: [
      { kind: "heatmap", slug: "enwl-gsp-heatmap", verified: false, licence: "OGL-UK-3.0" },
      {
        kind: "ecr",
        slug: "embedded-capacity-register",
        verified: false,
        licence: "OGL-UK-3.0",
        note: "ENWL publishes ECR down to 50 kW, below the 1 MW floor other DNOs use.",
      },
    ],
  },
  {
    id: "spen",
    name: "SP Energy Networks",
    portalHost: "spenergynetworks.opendatasoft.com",
    api: "ods",
    supported: true,
    attribution:
      "Contains SP Energy Networks data, licensed under the Open Government Licence v3.0.",
    datasets: [
      { kind: "heatmap", slug: "ltds-capacity-heatmap", verified: false, licence: "unconfirmed" },
      { kind: "ecr", slug: "embedded-capacity-register", verified: false, licence: "unconfirmed" },
    ],
  },
];

// Wording and freshness helpers live in lib/grid.ts; re-exported for
// callers that already import the registry.
export { gridCaveat, isStale, STALE_AFTER_DAYS } from "@/lib/grid";

export function dnoById(id: string): DnoEntry | undefined {
  return DNOS.find((d) => d.id === id);
}

export function supportedDnos(): DnoEntry[] {
  return DNOS.filter((d) => d.supported);
}
