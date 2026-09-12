/**
 * Companies House client.
 *
 * Turns a proprietor's company number - which CCOD and OCOD supply - into the
 * live company record: status, registered address, officers and persons with
 * significant control. That last one is the point for ESG work: it is what
 * answers "who actually controls this landlord".
 *
 * Free, but needs a key. Register at
 * https://developer.company-information.service.gov.uk and set
 * COMPANIES_HOUSE_API_KEY. Auth is HTTP Basic with the key as the username and
 * an empty password.
 *
 * Without a key every call returns null rather than throwing, so ownership
 * screening still works and simply reports the company details as unavailable.
 */

const BASE =
  process.env.COMPANIES_HOUSE_BASE ?? "https://api.company-information.service.gov.uk";

export type ChFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface CompanyProfile {
  companyNumber: string;
  name: string | null;
  status: string | null;
  type: string | null;
  incorporatedOn: string | null;
  registeredAddress: string | null;
  sicCodes: string[];
  /** True for dissolved, liquidation, administration and similar. */
  inactive: boolean;
}

export interface Officer {
  name: string;
  role: string | null;
  appointedOn: string | null;
  resignedOn: string | null;
  nationality: string | null;
}

export interface PscEntry {
  name: string;
  kind: string | null;
  natureOfControl: string[];
  notifiedOn: string | null;
  ceasedOn: string | null;
  countryRegistered: string | null;
}

export interface CompanyRecord {
  profile: CompanyProfile | null;
  officers: Officer[];
  psc: PscEntry[];
  /** Set when something could not be fetched. Never silently empty. */
  unavailable: string | null;
}

const ACTIVE_STATUSES = new Set(["active", "open"]);

function joinAddress(address: Record<string, unknown> | undefined): string | null {
  if (!address) return null;
  const parts = [
    "premises", "address_line_1", "address_line_2", "locality",
    "region", "postal_code", "country",
  ]
    .map((k) => address[k])
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return parts.length ? parts.join(", ") : null;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
  };
}

export interface ChOptions {
  apiKey?: string;
  fetchImpl?: ChFetch;
}

/**
 * Company numbers are eight characters, zero-padded, and may carry a prefix
 * (SC, NI, OC, FC...). CCOD supplies them inconsistently padded.
 */
export function normaliseCompanyNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (!trimmed) return null;
  const prefixed = /^([A-Z]{2})(\d+)$/.exec(trimmed);
  if (prefixed) return `${prefixed[1]}${prefixed[2].padStart(6, "0")}`;
  if (/^\d+$/.test(trimmed)) return trimmed.padStart(8, "0");
  return /^[A-Z0-9]{8}$/.test(trimmed) ? trimmed : null;
}

export async function getCompany(
  companyNumber: string,
  options: ChOptions = {},
): Promise<CompanyRecord> {
  const number = normaliseCompanyNumber(companyNumber);
  if (!number) {
    return { profile: null, officers: [], psc: [], unavailable: "Invalid company number" };
  }

  const apiKey = options.apiKey ?? process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) {
    return {
      profile: null,
      officers: [],
      psc: [],
      unavailable:
        "COMPANIES_HOUSE_API_KEY is not set, so company details could not be looked up.",
    };
  }

  const doFetch = options.fetchImpl ?? (fetch as unknown as ChFetch);
  const headers = authHeaders(apiKey);

  const get = async (path: string): Promise<unknown | null> => {
    try {
      const res = await doFetch(`${BASE}${path}`, { headers });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };

  const raw = (await get(`/company/${encodeURIComponent(number)}`)) as
    | Record<string, unknown>
    | null;

  if (!raw) {
    return {
      profile: null,
      officers: [],
      psc: [],
      unavailable: `Companies House returned no record for ${number}.`,
    };
  }

  const status = typeof raw.company_status === "string" ? raw.company_status : null;
  const profile: CompanyProfile = {
    companyNumber: number,
    name: typeof raw.company_name === "string" ? raw.company_name : null,
    status,
    type: typeof raw.type === "string" ? raw.type : null,
    incorporatedOn: typeof raw.date_of_creation === "string" ? raw.date_of_creation : null,
    registeredAddress: joinAddress(raw.registered_office_address as Record<string, unknown>),
    sicCodes: Array.isArray(raw.sic_codes) ? (raw.sic_codes as string[]) : [],
    inactive: status !== null && !ACTIVE_STATUSES.has(status.toLowerCase()),
  };

  const officersRaw = (await get(`/company/${encodeURIComponent(number)}/officers`)) as
    | { items?: Record<string, unknown>[] }
    | null;

  // A payload without an `items` array is a failure, not an empty list. Reading
  // an unexpected shape as "no officers" would turn a broken call into a
  // confident, wrong answer.
  const officersOk = Array.isArray(officersRaw?.items);

  const officers: Officer[] = (officersOk ? officersRaw!.items! : [])
    .map((item) => ({
      name: String(item.name ?? "").trim(),
      role: typeof item.officer_role === "string" ? item.officer_role : null,
      appointedOn: typeof item.appointed_on === "string" ? item.appointed_on : null,
      resignedOn: typeof item.resigned_on === "string" ? item.resigned_on : null,
      nationality: typeof item.nationality === "string" ? item.nationality : null,
    }))
    .filter((o) => o.name.length > 0);

  const pscRaw = (await get(
    `/company/${encodeURIComponent(number)}/persons-with-significant-control`,
  )) as { items?: Record<string, unknown>[] } | null;

  const pscOk = Array.isArray(pscRaw?.items);

  const psc: PscEntry[] = (pscOk ? pscRaw!.items! : [])
    .map((item) => ({
      name: String(item.name ?? "").trim(),
      kind: typeof item.kind === "string" ? item.kind : null,
      natureOfControl: Array.isArray(item.natures_of_control)
        ? (item.natures_of_control as string[])
        : [],
      notifiedOn: typeof item.notified_on === "string" ? item.notified_on : null,
      ceasedOn: typeof item.ceased_on === "string" ? item.ceased_on : null,
      countryRegistered:
        typeof item.identification === "object" && item.identification !== null
          ? ((item.identification as Record<string, unknown>).country_registered as string) ?? null
          : null,
    }))
    .filter((p) => p.name.length > 0);

  // A missing officers or PSC list is worth saying out loud: an empty PSC list
  // can mean "none declared", which is itself a finding, or that the call
  // failed. Don't let those look the same.
  const gaps: string[] = [];
  if (!officersOk) gaps.push("officers");
  if (!pscOk) gaps.push("persons with significant control");

  return {
    profile,
    officers,
    psc,
    unavailable: gaps.length ? `Could not retrieve ${gaps.join(" and ")}.` : null,
  };
}

/** Officers still in post. */
export function activeOfficers(record: CompanyRecord): Officer[] {
  return record.officers.filter((o) => !o.resignedOn);
}

/** Controlling parties still in place. */
export function activePsc(record: CompanyRecord): PscEntry[] {
  return record.psc.filter((p) => !p.ceasedOn);
}
