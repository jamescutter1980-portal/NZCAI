import type { ConsentStore } from "./store";
import { effectiveStatus, type ConsentRecord } from "./types";

export class ConsentError extends Error {
  constructor(
    message: string,
    public readonly code: "none" | "pending" | "expired" | "withdrawn" | "utility",
    public readonly consentId?: string,
  ) {
    super(message);
    this.name = "ConsentError";
  }
}

export interface GateOptions {
  /** Sandbox MPxNs are n3rgy test fixtures and need no occupier consent. */
  sandbox?: boolean;
  at?: Date;
}

export interface GateResult {
  consent?: ConsentRecord;
  /** Provenance consent reference: the consent id, or "sandbox". */
  consentRef: string;
}

/**
 * Returns the consent that authorises retrieval for an MPxN and utility, or
 * throws a ConsentError explaining why retrieval is not allowed. Where several
 * records exist, an active one wins; otherwise the most recently updated one
 * explains the refusal.
 */
export async function requireActiveConsent(
  store: ConsentStore,
  mpxn: string,
  utility: "electricity" | "gas",
  opts: GateOptions = {},
): Promise<GateResult> {
  if (opts.sandbox) return { consentRef: "sandbox" };
  const at = opts.at ?? new Date();
  const records = await store.findByMpxn(mpxn);
  if (records.length === 0) {
    throw new ConsentError(`No consent recorded for MPxN ${mpxn}. Record the occupier's consent before pulling data.`, "none");
  }
  const forUtility = records.filter((c) => c.utilities.includes(utility));
  if (forUtility.length === 0) {
    throw new ConsentError(`Consent for MPxN ${mpxn} does not cover ${utility}.`, "utility", records[0].id);
  }
  const active = forUtility.find((c) => effectiveStatus(c, at) === "active");
  if (active) return { consent: active, consentRef: active.id };

  const latest = [...forUtility].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const status = effectiveStatus(latest, at);
  const messages = {
    pending: `Consent for MPxN ${mpxn} is recorded but not yet verified as effective at n3rgy. Verify it first.`,
    expired: `Consent for MPxN ${mpxn} expired on ${latest.expiresOn}. Renew it before pulling data.`,
    withdrawn: `Consent for MPxN ${mpxn} was withdrawn${latest.withdrawnAt ? ` on ${latest.withdrawnAt.slice(0, 10)}` : ""}.`,
  } as const;
  if (status === "active") throw new Error("unreachable");
  throw new ConsentError(messages[status], status, latest.id);
}
