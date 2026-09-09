import { z } from "zod";
import type { Licence, Provenance } from "@/lib/provenance";

/**
 * Common shape for every external data source the portal talks to.
 *
 * A connector exports an IntegrationDefinition: metadata (access route,
 * territory, licence, attribution, required environment variables), a health
 * check, and a list of operations. Operations declare their parameters with
 * ParamSpec so the data-sources UI can render a form and the API route can
 * validate input without any per-connector UI code.
 */

export type AccessType =
  /** Publicly documented, no key. */
  | "open"
  /** Publicly documented, free or low-cost key by registration. */
  | "open_key"
  /** Needs the client's own account, consent or OAuth. */
  | "authorised"
  /** Subscription, licence or supplier agreement. */
  | "commercial"
  /** Map services or bulk files the portal must import. */
  | "gis"
  /** Bulk download refreshed on a schedule (annual factors, registers). */
  | "download"
  /** Provider exists; integration or redistribution rights need confirming. */
  | "enquiry";

export type IntegrationGroup =
  | "identity"
  | "energy"
  | "grid"
  | "carbon"
  | "flood_water"
  | "ground"
  | "weather"
  | "solar"
  | "nature"
  | "transport"
  | "company"
  | "embodied"
  | "pathways";

export const GROUP_LABELS: Record<IntegrationGroup, string> = {
  identity: "Building identity, EPCs and constraints",
  energy: "Energy consumption and meters",
  grid: "Electricity and gas networks",
  carbon: "Carbon factors and Scope 1-3",
  flood_water: "Flooding, drainage and water",
  ground: "Ground conditions and environmental liabilities",
  weather: "Weather, climate and normalisation",
  solar: "Solar, batteries and microgeneration",
  nature: "Biodiversity, habitats and land",
  transport: "Transport, fleet and logistics",
  company: "Social, governance and supplier ESG",
  embodied: "Embodied carbon and materials",
  pathways: "Net zero pathways and standards",
};

export type BuildStatus =
  /** Built and exercised against the live service. */
  | "live_verified"
  /** Built and tested against fixtures; live call not yet confirmed. */
  | "built_unverified"
  /** Registered with guidance only; no client because access is by contract, download or GIS import. */
  | "reference_only"
  | "planned";

export interface EnvVarSpec {
  name: string;
  required: boolean;
  description: string;
}

export type ParamType =
  | "string"
  | "text"
  | "number"
  | "integer"
  | "boolean"
  | "date"
  | "datetime"
  | "select"
  | "postcode"
  | "latitude"
  | "longitude"
  | "uprn"
  | "mpxn";

export interface ParamSpec {
  name: string;
  label: string;
  type: ParamType;
  required?: boolean;
  options?: { value: string; label: string }[];
  default?: string | number | boolean;
  placeholder?: string;
  help?: string;
  min?: number;
  max?: number;
}

export type EnvLike = Record<string, string | undefined>;
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OperationContext {
  fetch: FetchLike;
  env: EnvLike;
  now: () => Date;
  signal?: AbortSignal;
}

export interface OperationResult {
  /** One or two sentences a non-specialist can read. */
  summary: string;
  /** Tabular view. Columns are keys of each row. */
  columns?: string[];
  rows?: Record<string, unknown>[];
  /** Raw upstream payload for inspection and export. */
  raw?: unknown;
  provenance: Provenance;
  warnings?: string[];
  links?: { label: string; url: string }[];
}

export interface OperationDefinition {
  id: string;
  label: string;
  description: string;
  params: ParamSpec[];
  run(params: Record<string, unknown>, ctx: OperationContext): Promise<OperationResult>;
}

export interface HealthResult {
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

export interface IntegrationDefinition {
  id: string;
  name: string;
  group: IntegrationGroup;
  access: AccessType;
  /** e.g. "England", "England and Wales", "GB", "UK", "Global". */
  territory: string;
  description: string;
  docsUrl: string;
  termsUrl?: string;
  attribution: string;
  licence: Licence;
  envVars: EnvVarSpec[];
  status: BuildStatus;
  /** Caveats, unverified points, how to obtain access. */
  notes?: string[];
  operations: OperationDefinition[];
  healthCheck?(ctx: OperationContext): Promise<HealthResult>;
}

export function defineIntegration(def: IntegrationDefinition): IntegrationDefinition {
  const ids = new Set<string>();
  for (const op of def.operations) {
    if (ids.has(op.id)) throw new Error(`${def.id}: duplicate operation id ${op.id}`);
    ids.add(op.id);
  }
  return def;
}

/** Which required environment variables are missing. */
export function checkConfigured(def: IntegrationDefinition, env: EnvLike): { configured: boolean; missing: string[] } {
  const missing = def.envVars.filter((v) => v.required && !env[v.name]?.trim()).map((v) => v.name);
  return { configured: missing.length === 0, missing };
}

const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i;

/** Builds a zod schema from ParamSpecs. Strings from forms are coerced. */
export function paramsToSchema(params: ParamSpec[]): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of params) {
    let s: z.ZodTypeAny;
    switch (p.type) {
      case "number":
      case "latitude":
      case "longitude": {
        let n = z.coerce.number();
        if (p.type === "latitude") n = n.min(-90).max(90);
        if (p.type === "longitude") n = n.min(-180).max(180);
        if (p.min !== undefined) n = n.min(p.min);
        if (p.max !== undefined) n = n.max(p.max);
        s = n;
        break;
      }
      case "integer": {
        let n = z.coerce.number().int();
        if (p.min !== undefined) n = n.min(p.min);
        if (p.max !== undefined) n = n.max(p.max);
        s = n;
        break;
      }
      case "boolean":
        s = z.preprocess((v) => (v === "true" || v === "on" ? true : v === "false" || v === "" ? false : v), z.boolean());
        break;
      case "date":
        s = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
        break;
      case "datetime":
        s = z.string().min(10);
        break;
      case "select":
        s = z.enum((p.options ?? []).map((o) => o.value) as [string, ...string[]]);
        break;
      case "postcode":
        s = z.string().trim().regex(POSTCODE, "not a UK postcode").transform((v) => v.toUpperCase().replace(/\s+/g, ""));
        break;
      case "uprn":
        s = z.string().trim().regex(/^\d{1,12}$/, "UPRN must be up to 12 digits");
        break;
      case "mpxn":
        s = z.string().trim().regex(/^\d{6,13}$/, "MPxN must be 6 to 13 digits");
        break;
      default:
        s = z.string().trim();
    }
    if (!p.required) {
      s = z.preprocess((v) => (v === "" || v === null ? undefined : v), s.optional());
      if (p.default !== undefined) s = s.default(p.default);
    }
    shape[p.name] = s;
  }
  return z.object(shape);
}

export class IntegrationHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(message);
    this.name = "IntegrationHttpError";
  }
}

export interface FetchJsonOptions {
  timeoutMs?: number;
  /** Accept these non-2xx statuses and return the parsed body. */
  acceptStatuses?: number[];
}

/** GET/POST JSON with timeout and a consistent error. */
export async function fetchJson<T = unknown>(
  ctx: OperationContext,
  url: string,
  init: RequestInit = {},
  opts: FetchJsonOptions = {},
): Promise<{ data: T; status: number; headers: Headers }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  const onOuterAbort = () => controller.abort();
  ctx.signal?.addEventListener("abort", onOuterAbort);
  try {
    const res = await ctx.fetch(url, {
      ...init,
      headers: { accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok && !opts.acceptStatuses?.includes(res.status)) {
      throw new IntegrationHttpError(`HTTP ${res.status} from ${new URL(url).host}`, res.status, url, text.slice(0, 1000));
    }
    let data: T;
    try {
      data = (text ? JSON.parse(text) : null) as T;
    } catch {
      throw new IntegrationHttpError(`Non-JSON response from ${new URL(url).host}`, res.status, url, text.slice(0, 1000));
    }
    return { data, status: res.status, headers: res.headers };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** GET text (CSV, XML) with timeout. */
export async function fetchText(ctx: OperationContext, url: string, init: RequestInit = {}, opts: FetchJsonOptions = {}): Promise<{ text: string; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await ctx.fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok && !opts.acceptStatuses?.includes(res.status)) {
      throw new IntegrationHttpError(`HTTP ${res.status} from ${new URL(url).host}`, res.status, url, text.slice(0, 1000));
    }
    return { text, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

export function buildUrl(base: string, path: string, query: Record<string, string | number | boolean | undefined | null> = {}): string {
  const url = new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : base + "/");
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export function makeProvenance(
  def: IntegrationDefinition,
  ctx: OperationContext,
  overrides: Partial<Provenance> & { dataset: string; basis: Provenance["basis"] },
): Provenance {
  return {
    source: def.id,
    territory: def.territory,
    licence: def.licence,
    attribution: def.attribution,
    retrievedAt: ctx.now().toISOString(),
    ...overrides,
  };
}

/** Standard health check: GET a URL, ok on 2xx. */
export function simpleHealth(url: string | ((env: EnvLike) => string), init?: RequestInit | ((env: EnvLike) => RequestInit)) {
  return async (ctx: OperationContext): Promise<HealthResult> => {
    const started = Date.now();
    const target = typeof url === "function" ? url(ctx.env) : url;
    const i = typeof init === "function" ? init(ctx.env) : init;
    try {
      const res = await ctx.fetch(target, { ...i, signal: AbortSignal.timeout(15_000) });
      const latencyMs = Date.now() - started;
      if (res.ok) return { ok: true, detail: `HTTP ${res.status}`, latencyMs };
      return { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, latencyMs };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  };
}

export function defaultContext(env: EnvLike = process.env): OperationContext {
  return { fetch: (input, init) => fetch(input, init), env, now: () => new Date() };
}
