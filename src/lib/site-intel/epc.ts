/**
 * Task 0: the EPC register.
 *
 * This is the step the brief calls housekeeping and which turned out to be the
 * unlock for three other sections. It supplies the one thing S-01 needs to
 * reach an `exact` match - an address-to-UPRN lookup from a register - and the
 * street address that S-04 (ownership) and S-06 (VOA) need to get past
 * postcode-only matching.
 *
 * ENDPOINT. EPC open data has moved to
 * get-energy-performance-data.communities.gov.uk. The legacy host,
 * epc.opendatacommunities.org, has no published retirement date and speaks the
 * same API. `EPC_API_BASE` selects the host so a move in either direction is a
 * config change - see PRELAUNCH.md.
 *
 * THE THING TO BE CAREFUL ABOUT. The register carries a `uprn` field, but it is
 * not uniformly authoritative: `uprn-source` distinguishes a UPRN the energy
 * assessor typed in from one the register matched algorithmically. Treating
 * both as a register-grade identifier would be wrong, so they carry different
 * tiers and the source is always reported.
 *
 * Three registers, same shape:
 *   domestic      dwellings
 *   non-domestic  commercial - the one that matters for this product
 *   display       DECs for public buildings
 */

import { normalisePostcode } from "./geo";
import { lineage } from "./sources";
import type { AddressMatch, AddressRegister } from "./resolve";
import type { SourceRecord, Tier } from "./types";

export type EpcRegister = "domestic" | "non-domestic" | "display";

export const EPC_REGISTERS: EpcRegister[] = ["domestic", "non-domestic", "display"];

const DEFAULT_BASE =
  process.env.EPC_API_BASE ?? "https://get-energy-performance-data.communities.gov.uk";

/** The pre-migration host. Kept so a fallback is a config change, not a code one. */
export const LEGACY_BASE = "https://epc.opendatacommunities.org";

export type EpcFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * How the register came by the UPRN.
 *
 * "Address Matched" is the register's own matching against the authoritative
 * address base. "Energy Assessor" is a human typing it into assessment
 * software, which is useful but not the same thing.
 */
export type UprnSource = "address_matched" | "energy_assessor" | "unknown" | "none";

export interface EpcCertificate {
  /** The register's own certificate key. */
  lmkKey: string;
  register: EpcRegister;
  address: string;
  postcode: string | null;
  uprn: string | null;
  uprnSource: UprnSource;
  /** A-G. `current-energy-rating` domestic, `asset-rating-band` non-domestic. */
  rating: string | null;
  /** Numeric asset rating, non-domestic only. */
  assetRating: number | null;
  floorAreaM2: number | null;
  inspectionDate: string | null;
  lodgementDate: string | null;
  propertyType: string | null;
  buildingReference: string | null;

  /* S-05 performance fields. Absent on some registers; null is not zero. */

  /** Primary heating fuel as the register spells it. Raw, not classified. */
  mainFuel: string | null;
  /** Building Emission Rate, kgCO2/m²/yr. The band is derived from this. */
  buildingEmissions: number | null;
  /** Target Emission Rate for the notional building, kgCO2/m²/yr. */
  targetEmissions: number | null;
  /** Standard Emission Rate, kgCO2/m²/yr. */
  standardEmissions: number | null;
  /** Primary energy use, kWh/m²/yr. */
  primaryEnergy: number | null;
  /** Why the certificate exists, e.g. "Mandatory issue (Marketed sale)". */
  transactionType: string | null;
}

export interface EpcLookup {
  certificates: EpcCertificate[];
  /** Set when the register could not be consulted. Never silently empty. */
  unavailable: string | null;
  /** Which host answered, so a migration is visible in the output. */
  base: string;
}

export interface EpcOptions {
  email?: string;
  apiKey?: string;
  base?: string;
  fetchImpl?: EpcFetch;
  /** Registers to search. Defaults to all three. */
  registers?: EpcRegister[];
  limit?: number;
}

/* --------------------------------------------------------------- parsing --- */

function str(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function numeric(row: Record<string, unknown>, ...keys: string[]): number | null {
  const raw = str(row, ...keys);
  if (raw === null) return null;
  const parsed = Number(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseUprnSource(raw: string | null): UprnSource {
  if (!raw) return "unknown";
  const text = raw.toLowerCase();
  if (text.includes("address") && text.includes("match")) return "address_matched";
  if (text.includes("assessor")) return "energy_assessor";
  return "unknown";
}

/** Joins the register's address1..3 columns, dropping blanks and duplicates. */
export function composeAddress(row: Record<string, unknown>): string {
  const direct = str(row, "address");
  if (direct) return direct;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const key of ["address1", "address2", "address3"]) {
    const value = str(row, key);
    if (value && !seen.has(value.toLowerCase())) {
      seen.add(value.toLowerCase());
      parts.push(value);
    }
  }
  return parts.join(", ");
}

export function toCertificate(
  row: Record<string, unknown>,
  register: EpcRegister,
): EpcCertificate | null {
  const lmkKey = str(row, "lmk-key", "lmkKey");
  if (!lmkKey) return null;

  const uprn = str(row, "uprn");
  return {
    lmkKey,
    register,
    address: composeAddress(row),
    postcode: normalisePostcode(str(row, "postcode") ?? ""),
    uprn,
    uprnSource: uprn ? parseUprnSource(str(row, "uprn-source", "uprnSource")) : "none",
    rating: str(row, "asset-rating-band", "current-energy-rating", "operational-rating-band"),
    assetRating: numeric(row, "asset-rating", "operational-rating"),
    floorAreaM2: numeric(row, "total-floor-area", "floor-area"),
    inspectionDate: str(row, "inspection-date", "nominated-date"),
    lodgementDate: str(row, "lodgement-date", "lodgement-datetime"),
    propertyType: str(row, "property-type", "building-category", "building-level"),
    buildingReference: str(row, "building-reference-number"),

    // The three registers name these differently; the aliases are tried in
    // order of how authoritative the column is for a non-domestic assessment.
    mainFuel: str(row, "main-heating-fuel", "main-fuel", "mainheat-description"),
    buildingEmissions: numeric(row, "building-emissions", "co2-emissions-current"),
    targetEmissions: numeric(row, "target-emissions"),
    standardEmissions: numeric(row, "standard-emissions"),
    primaryEnergy: numeric(row, "primary-energy-value", "energy-consumption-current"),
    transactionType: str(row, "transaction-type"),
  };
}

/* ---------------------------------------------------------------- client --- */

function authHeader(email: string, apiKey: string): string {
  return `Basic ${Buffer.from(`${email}:${apiKey}`).toString("base64")}`;
}

/**
 * Certificates for a postcode, across the requested registers.
 *
 * A register that fails is named in `unavailable` rather than contributing
 * silence: "this postcode has no non-domestic EPC" and "the non-domestic
 * register did not answer" are different findings.
 */
export async function certificatesByPostcode(
  rawPostcode: string,
  options: EpcOptions = {},
): Promise<EpcLookup> {
  const base = options.base ?? DEFAULT_BASE;
  const postcode = normalisePostcode(rawPostcode);
  if (!postcode) {
    return { certificates: [], unavailable: `"${rawPostcode}" is not a valid UK postcode`, base };
  }

  const email = options.email ?? process.env.EPC_API_EMAIL;
  const apiKey = options.apiKey ?? process.env.EPC_API_KEY;
  if (!email || !apiKey) {
    return {
      certificates: [],
      unavailable:
        "EPC_API_EMAIL and EPC_API_KEY are not set, so the EPC register could not be searched. " +
        "Register free at https://epc.opendatacommunities.org/login-or-register",
      base,
    };
  }

  const doFetch = options.fetchImpl ?? (fetch as unknown as EpcFetch);
  const registers = options.registers ?? EPC_REGISTERS;
  const size = options.limit ?? 100;

  const certificates: EpcCertificate[] = [];
  const failed: string[] = [];

  for (const register of registers) {
    const url =
      `${base}/api/v1/${register}/search` +
      `?postcode=${encodeURIComponent(postcode)}&size=${size}`;
    try {
      const res = await doFetch(url, {
        headers: { accept: "application/json", authorization: authHeader(email, apiKey) },
      });
      // 404 is the register's way of saying "nothing here", which is an answer.
      if (res.status === 404) continue;
      if (!res.ok) { failed.push(register); continue; }

      const body = (await res.json()) as { rows?: Record<string, unknown>[] };
      if (!Array.isArray(body.rows)) { failed.push(register); continue; }

      for (const row of body.rows) {
        const certificate = toCertificate(row, register);
        if (certificate) certificates.push(certificate);
      }
    } catch {
      failed.push(register);
    }
  }

  return {
    certificates,
    unavailable: failed.length
      ? `The ${failed.join(" and ")} register${failed.length > 1 ? "s" : ""} did not respond, so those results are missing rather than absent.`
      : null,
    base,
  };
}

/* ------------------------------------------------------------- selection --- */

/** Most recent certificate first, by inspection then lodgement date. */
export function byRecency(a: EpcCertificate, b: EpcCertificate): number {
  const key = (c: EpcCertificate): string => c.inspectionDate ?? c.lodgementDate ?? "";
  return key(b).localeCompare(key(a));
}

/**
 * The certificate that best describes a building, preferring a current
 * non-domestic assessment over an older or domestic one.
 */
export function currentCertificate(certificates: EpcCertificate[]): EpcCertificate | null {
  if (!certificates.length) return null;
  const nonDomestic = certificates.filter((c) => c.register === "non-domestic");
  return [...(nonDomestic.length ? nonDomestic : certificates)].sort(byRecency)[0];
}

/**
 * Tier for a UPRN taken from the register.
 *
 * An address-matched UPRN is register-grade (T1). An assessor-entered one is a
 * human typing a number into assessment software - useful, but a different
 * thing, so it is inferred (T3).
 */
export function uprnTier(source: UprnSource): Tier {
  return source === "address_matched" ? "T1" : "T3";
}

export function certificateLineage(certificate: EpcCertificate): SourceRecord {
  return lineage({
    sourceId: "epc-register",
    entityRef: certificate.lmkKey,
    method: `${certificate.register} register, postcode search; UPRN source ${certificate.uprnSource.replace("_", " ")}`,
    tier: certificate.uprn ? uprnTier(certificate.uprnSource) : "T2",
    sourceUpdated: certificate.lodgementDate ?? certificate.inspectionDate,
  });
}

/* -------------------------------------------------- AddressRegister impl --- */

/**
 * Satisfies the resolution chain's step (a). Given a free-text address, finds
 * certificates in its postcode and returns those whose address agrees, so the
 * chain can reach `exact`.
 *
 * Only certificates carrying a UPRN are returned: without one there is nothing
 * for step (b) to look up in OS Open UPRN, and a match with no identifier would
 * be an address, not a resolution.
 */
export function epcAddressRegister(options: EpcOptions = {}): AddressRegister {
  return {
    async lookup(address: string): Promise<AddressMatch[]> {
      const { extractPostcode } = await import("./geo");
      const { addressTokens, addressScore, numberConflict, ADDRESS_MATCH_THRESHOLD } =
        await import("./address-match");

      const postcode = extractPostcode(address);
      if (!postcode) return [];

      const { certificates } = await certificatesByPostcode(postcode, options);
      const siteTokens = addressTokens(address);

      return certificates
        .filter((c) => c.uprn)
        .map((c) => ({ c, score: addressScore(siteTokens, addressTokens(c.address)) }))
        .filter(({ c, score }) =>
          score >= ADDRESS_MATCH_THRESHOLD &&
          !numberConflict(siteTokens, addressTokens(c.address)),
        )
        .sort((a, b) => b.score - a.score)
        .map(({ c }) => ({
          uprn: c.uprn as string,
          address: c.address,
          postcode: c.postcode,
        }));
    },
  };
}
