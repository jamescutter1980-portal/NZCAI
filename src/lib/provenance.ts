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
  | "OGL"
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
