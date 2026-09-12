/**
 * Provenance fields carried by every value the portal imports from an
 * external source. See docs/data-source-roadmap.md §6.
 */

export type Basis =
  | "measured"
  | "estimated"
  | "modelled"
  | "client_declared"
  | "unavailable"
  | "not_applicable";

export type Licence =
  /** Open Government Licence v3.0 */
  | "OGL"
  | "CC_BY"
  | "CC_BY_SA"
  | "CC0"
  /** Open data under the publisher's own licence (Elexon BMRS, Octopus, and similar) */
  | "open_other"
  /** Licence varies per record or dataset (NBN Atlas, GBIF); check each result */
  | "mixed"
  | "restricted"
  | "commercial"
  | "consent_based";

export interface Provenance {
  /** Source system identifier, e.g. "n3rgy". */
  source: string;
  /** Dataset or endpoint name within the source. */
  dataset: string;
  /** Source-declared version, if any. */
  version?: string;
  /** ISO 8601 instant at which the portal retrieved the value. */
  retrievedAt: string;
  /** Territory the source covers, e.g. "GB". */
  territory: string;
  licence: Licence;
  /** Attribution text the UI must display for this source. */
  attribution: string;
  basis: Basis;
  /** Reference to the consent record that authorised retrieval, if consent based. */
  consentRef?: string;
}
