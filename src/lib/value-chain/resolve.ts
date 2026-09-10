import type { Db } from "@/lib/db/sqlite";
import type { OperationContext } from "@/lib/integrations/framework";
import { runSourceOperation } from "@/lib/integrations/service";
import { CounterpartyNotFoundError, CounterpartyRepository } from "./repo";
import type { CounterpartyRecord } from "./types";

/**
 * Resolves a counterparty to a legal entity on the Companies House register.
 * Search proposes candidates; a person picks one; the profile then fills the
 * company number and sector and reports the register status. Nothing is
 * applied without the pick, and nothing here computes a figure.
 */
export interface Candidate {
  companyName: string;
  companyNumber: string;
  status: string | null;
  type: string | null;
  incorporated: string | null;
  address: string | null;
}

export async function searchCandidates(query: string, ctx: OperationContext, limit = 8): Promise<Candidate[]> {
  const result = await runSourceOperation("companies-house", "search", { q: query, items_per_page: limit }, ctx);
  return (result.rows ?? []).map((r) => ({
    companyName: String(r.company_name ?? ""),
    companyNumber: String(r.company_number ?? ""),
    status: (r.status as string | null) ?? null,
    type: (r.type as string | null) ?? null,
    incorporated: (r.incorporated as string | null) ?? null,
    address: (r.address as string | null) ?? null,
  }));
}

export interface Resolution {
  counterparty: CounterpartyRecord;
  profile: { companyName: string; companyNumber: string; status: string | null; sicCodes: string; registeredOffice: string; incorporated: string | null; ceased: string | null };
  /** What changed on the counterparty. */
  applied: string[];
  warnings: string[];
}

/** Fetches the profile for a company number and applies number, sector and, where the register says so, an inactive status. */
export async function resolveCounterparty(db: Db, counterpartyId: string, companyNumber: string, ctx: OperationContext): Promise<Resolution> {
  const repo = new CounterpartyRepository(db);
  const current = repo.get(counterpartyId);
  if (!current) throw new CounterpartyNotFoundError(counterpartyId);
  const result = await runSourceOperation("companies-house", "profile", { company_number: companyNumber }, ctx);
  const row = result.rows?.[0];
  if (!row) throw new Error(result.summary);

  const profile = {
    companyName: String(row.company_name ?? ""),
    companyNumber: String(row.company_number ?? companyNumber),
    status: (row.status as string | null) ?? null,
    sicCodes: String(row.sic_codes ?? ""),
    registeredOffice: String(row.registered_office ?? ""),
    incorporated: (row.incorporated as string | null) ?? null,
    ceased: (row.ceased as string | null) ?? null,
  };
  const warnings = [...(result.warnings ?? [])];
  const applied: string[] = [];
  const patch: { companyNumber: string; sector?: string; country?: string } = { companyNumber: profile.companyNumber };
  applied.push(`company number ${profile.companyNumber}`);
  if (profile.sicCodes && !current.sector) {
    patch.sector = profile.sicCodes.slice(0, 120);
    applied.push(`sector from SIC codes: ${patch.sector}`);
  }
  if (!current.country) {
    patch.country = "GB";
    applied.push("country GB");
  }
  if (profile.companyName && profile.companyName.toLowerCase() !== current.name.toLowerCase()) {
    warnings.push(`The register name is "${profile.companyName}"; the counterparty is recorded as "${current.name}". The recorded name is kept.`);
  }
  if (profile.status && profile.status !== "active") {
    warnings.push(`Companies House records the company as ${profile.status}${profile.ceased ? ` (ceased ${profile.ceased})` : ""}. Check whether the relationship is still live.`);
  }
  const counterparty = repo.update(counterpartyId, patch, ctx.now());
  return { counterparty, profile, applied, warnings };
}
