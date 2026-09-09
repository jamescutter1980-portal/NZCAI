import { z } from "zod";

/**
 * Consent record for retrieving metered data on a supply point.
 *
 * n3rgy only releases data for an MPxN once the occupier has consented to the
 * portal's n3rgy account. The portal records that consent here so every
 * retrieval can cite it (Provenance.consentRef) and so lapsed consents block
 * retrieval rather than silently failing at the API.
 */

export const consentMethodSchema = z.enum([
  /** Occupier granted access to our organisation in n3rgy's consumer portal. */
  "n3rgy_consumer_portal",
  /** Signed letter of authority held by us and lodged with n3rgy. */
  "letter_of_authority",
  /** Consent embedded in a lease, green lease rider or services contract. */
  "contract_clause",
  "other",
]);
export type ConsentMethod = z.infer<typeof consentMethodSchema>;

export const storedStatusSchema = z.enum(["pending", "active", "withdrawn"]);
export type StoredStatus = z.infer<typeof storedStatusSchema>;

/** Effective status adds the time-derived "expired" state. */
export type ConsentStatus = StoredStatus | "expired";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const mpxn = z.string().regex(/^\d{6,13}$/, "MPxN must be 6 to 13 digits");

export const consentCreateSchema = z.object({
  mpxn,
  utilities: z.array(z.enum(["electricity", "gas"])).min(1),
  /** Portal asset or site reference this supply point belongs to, if known. */
  assetRef: z.string().max(120).optional(),
  siteAddress: z.string().max(300).optional(),
  occupierName: z.string().min(1).max(200),
  occupierEmail: z.email().optional(),
  occupierOrganisation: z.string().max(200).optional(),
  method: consentMethodSchema,
  /** Reference on the evidence: n3rgy consent id, LoA document id, lease clause. */
  evidenceRef: z.string().max(200).optional(),
  grantedOn: isoDate,
  expiresOn: isoDate,
  /** Whether the consent is already effective at n3rgy. Defaults to pending until verified. */
  status: storedStatusSchema.default("pending"),
  notes: z.string().max(2000).optional(),
  recordedBy: z.string().max(200).optional(),
});
export type ConsentCreate = z.infer<typeof consentCreateSchema>;

export const consentUpdateSchema = z
  .object({
    status: storedStatusSchema.optional(),
    expiresOn: isoDate.optional(),
    evidenceRef: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
    assetRef: z.string().max(120).optional(),
    withdrawnReason: z.string().max(500).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "no fields to update");
export type ConsentUpdate = z.infer<typeof consentUpdateSchema>;

export interface ConsentRecord extends ConsentCreate {
  id: string;
  status: StoredStatus;
  createdAt: string;
  updatedAt: string;
  withdrawnAt?: string;
  withdrawnReason?: string;
  /** Result of the last check against n3rgy. */
  lastVerifiedAt?: string;
  lastVerificationResult?: "granted" | "refused" | "error";
  lastVerificationDetail?: string;
}

export interface ConsentView extends ConsentRecord {
  effectiveStatus: ConsentStatus;
  daysToExpiry: number;
}

/** Derives the effective status at a point in time. */
export function effectiveStatus(c: ConsentRecord, at: Date = new Date()): ConsentStatus {
  if (c.status === "withdrawn") return "withdrawn";
  if (hasExpired(c.expiresOn, at)) return "expired";
  return c.status;
}

export function hasExpired(expiresOn: string, at: Date): boolean {
  const endOfDay = new Date(`${expiresOn}T23:59:59.999Z`);
  return at > endOfDay;
}

export function toView(c: ConsentRecord, at: Date = new Date()): ConsentView {
  const end = new Date(`${c.expiresOn}T23:59:59.999Z`);
  return {
    ...c,
    effectiveStatus: effectiveStatus(c, at),
    daysToExpiry: Math.ceil((end.getTime() - at.getTime()) / 86_400_000),
  };
}

/** Default consent term used by the UI when none is given. */
export function defaultExpiry(grantedOn: string, months = 12): string {
  const d = new Date(`${grantedOn}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
