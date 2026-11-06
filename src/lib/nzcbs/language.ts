import { PRE_VERIFICATION_STATEMENT, STANDARD_NAME } from "./constants";
import type { Approach, FindingStatus } from "./types";

/**
 * Section 7: what may be said about a building. Before verification only the
 * "targeting verification" statement is permitted (7.4.1); "aligned",
 * "compliant with" and "certified to" are prohibited (7.4.1, 7.5). After
 * verification the exact phrases of 7.4.2 apply, with the claim dates.
 */

export const STATUS_LABELS: Record<FindingStatus, string> = {
  pass: "within limit",
  fail: "above limit",
  reported: "reported",
  not_assessable: "not assessable",
  not_applicable: "not applicable",
};

export const PROHIBITED_PHRASES = [
  /net zero carbon aligned/i,
  /\baligned (with|to) the (uk )?(net zero carbon buildings )?standard/i,
  /\bcompliant with (the )?(uk )?nzcbs/i,
  /\bcompliant with the (uk )?net zero carbon buildings standard/i,
  /\bcertified (to|against) (the )?(uk )?(nzcbs|net zero carbon buildings standard)/i,
  /\bnzcbs[- ](compliant|certified|aligned|verified)/i,
  /\bconforms? (to|with) the (uk )?net zero carbon buildings standard/i,
];

/** True when text makes a claim that 7.4.1 or 7.5 forbids before verification. */
export function containsProhibitedClaim(text: string): boolean {
  return PROHIBITED_PHRASES.some((re) => re.test(text));
}

/** The one statement permitted before verification (7.4.1). */
export function preVerificationStatement(): string {
  return PRE_VERIFICATION_STATEMENT;
}

export interface VerifiedClaimInput {
  approach: Approach;
  version: string;
  orpFrom: string;
  orpTo: string;
  withOffsets?: boolean;
}

/** The exact phrases of 7.4.2, for use only once NZCBS Ltd has approved the verification. */
export function verifiedClaimStatement(c: VerifiedClaimInput): { phrase: string; statement: string } {
  const phrase = (c.approach === "whole-building" ? "Net Zero Carbon Aligned Building" : c.approach === "landlord-only" ? "Net Zero Carbon Aligned Landlord Spaces" : "Net Zero Carbon Aligned Tenancy") + (c.withOffsets ? " (plus offsets)" : "");
  return { phrase, statement: `verified to ${c.version} of the ${STANDARD_NAME} as being a ${phrase} for the dates ${c.orpFrom} to ${c.orpTo}` };
}

/** 7.4.2: every communication of a verification must carry these. */
export const VERIFIED_COMMUNICATION_MUST_INCLUDE = [
  "Standard version (4.1.2)",
  "Type of building and works (4.2.1)",
  "Sectors and subsectors within the building (4.2.1.1)",
  "Date of the Reporting Period End Point (4.2.4.1)",
  "Start and end dates of the Operational Reporting Period (4.2.4.2)",
  "Date of the limits and targets used (4.2.5.3)",
] as const;
