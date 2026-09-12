import { buildUrl, defineIntegration, fetchJson, makeProvenance, type EnvLike, type HealthResult, type OperationContext } from "../framework";
import { assertRange, chunkDays } from "../_shared/dates";

/**
 * Hildebrand Glowmarkt API (Bright app account): DCC smart-meter data with the
 * occupier's consent.
 *
 * Endpoints, headers and shapes confirmed from the open-source pyglowmarkt
 * client (cybermaggedon/pyglowmarkt, used by the Home Assistant Hildebrand
 * Glow (DCC) integration) and the Glowmarkt API data-retrieval documentation:
 *   POST /auth {username,password} + header applicationId -> {valid, token, exp, ...}
 *   GET  /virtualentity                       -> [{veId, name, postalCode, veTypeId, applicationId, resources?}]
 *   GET  /virtualentity/{veId}/resources      -> {resources:[{resourceId, resourceTypeId, name, classifier, description, baseUnit}]}
 *   GET  /resource/{id}/readings?from&to&period&offset&function&nulls -> {data:[[epochSeconds,value]], units, ...}
 * The Bright application id b0f1b774-a586-4f72-9edd-27ead8aa7a8d is the one
 * hard-coded in pyglowmarkt. The documented per-request range limit is 10 days
 * for PT30M; the 31-day limit used here for P1D is taken from the same table
 * but not re-checked. Not exercised live from this codebase.
 */

export const DEFAULT_BASE = "https://api.glowmarkt.com/api/v0-1";
export const DEFAULT_APPLICATION_ID = "b0f1b774-a586-4f72-9edd-27ead8aa7a8d";

const RANGE_LIMIT_DAYS: Record<string, number> = { PT30M: 10, PT1H: 31, P1D: 31 };
const MAX_REQUEST_DAYS: Record<string, number> = { PT30M: 100, PT1H: 186, P1D: 366 };

export function apiBase(env: EnvLike): string {
  return (env.GLOWMARKT_API_BASE?.trim() || DEFAULT_BASE).replace(/\/$/, "");
}

export function applicationId(env: EnvLike): string {
  return env.GLOWMARKT_APPLICATION_ID?.trim() || DEFAULT_APPLICATION_ID;
}

function credentials(env: EnvLike): { username: string; password: string } {
  const username = env.GLOWMARKT_USERNAME?.trim();
  const password = env.GLOWMARKT_PASSWORD;
  if (!username || !password) throw new Error("GLOWMARKT_USERNAME and GLOWMARKT_PASSWORD are not set");
  return { username, password };
}

interface AuthResponse {
  valid?: boolean;
  token?: string;
  /** Expiry as epoch seconds (pyglowmarkt ignores it; Glow docs show seconds). */
  exp?: number;
  userId?: string;
  error?: string;
}

interface CachedToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/** Clears cached tokens (tests, or after a password change). */
export function resetTokenCache(): void {
  tokenCache.clear();
}

function cacheKey(env: EnvLike, username: string): string {
  return `${apiBase(env)}|${applicationId(env)}|${username}`;
}

/** Token from the in-memory cache when at least 60 s of validity remains, otherwise POST /auth. */
export async function getToken(ctx: OperationContext): Promise<string> {
  const { username, password } = credentials(ctx.env);
  const key = cacheKey(ctx.env, username);
  const now = ctx.now().getTime();
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - 60_000 > now) return cached.token;
  const { data } = await fetchJson<AuthResponse>(
    ctx,
    buildUrl(apiBase(ctx.env), "auth"),
    { method: "POST", headers: { "content-type": "application/json", applicationId: applicationId(ctx.env) }, body: JSON.stringify({ username, password }) },
    { timeoutMs: 20_000 },
  );
  if (!data || data.valid === false || !data.token) throw new Error(`Glowmarkt authentication failed${data?.error ? `: ${data.error}` : ""}`);
  const exp = typeof data.exp === "number" && Number.isFinite(data.exp) ? (data.exp > 1e12 ? data.exp : data.exp * 1000) : now + 6 * 3_600_000;
  tokenCache.set(key, { token: data.token, expiresAt: exp });
  return data.token;
}

async function authHeaders(ctx: OperationContext): Promise<Record<string, string>> {
  return { applicationId: applicationId(ctx.env), token: await getToken(ctx), "content-type": "application/json" };
}

export interface Resource {
  resourceId: string;
  resourceTypeId?: string;
  name?: string;
  classifier?: string;
  description?: string;
  baseUnit?: string;
}

export interface VirtualEntity {
  veId: string;
  veTypeId?: string;
  name?: string;
  postalCode?: string;
  applicationId?: string;
  resources?: Resource[];
}

interface ReadingsResponse {
  status?: string;
  name?: string;
  resourceId?: string;
  classifier?: string;
  units?: string;
  data?: [number, number | null][];
  query?: unknown;
}

export async function listVirtualEntities(ctx: OperationContext): Promise<VirtualEntity[]> {
  const headers = await authHeaders(ctx);
  const { data } = await fetchJson<VirtualEntity[]>(ctx, buildUrl(apiBase(ctx.env), "virtualentity"), { headers });
  const ves = Array.isArray(data) ? data : [];
  return Promise.all(
    ves.map(async (ve) => {
      if (Array.isArray(ve.resources)) return ve;
      const { data: r } = await fetchJson<{ resources?: Resource[] }>(ctx, buildUrl(apiBase(ctx.env), `virtualentity/${encodeURIComponent(ve.veId)}/resources`), { headers });
      return { ...ve, resources: r?.resources ?? [] };
    }),
  );
}

export function epochToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.000Z$/, "Z");
}

/** Unit column name for the resource's base unit / readings units. */
export function unitKey(units: string | undefined): "kwh" | "m3" | "pence" | "value" {
  const u = (units ?? "").toLowerCase();
  if (u === "kwh") return "kwh";
  if (u === "m3" || u === "m³") return "m3";
  if (u === "pence" || u === "p") return "pence";
  return "value";
}

export const definition = defineIntegration({
  id: "hildebrand-glowmarkt",
  name: "Hildebrand Glowmarkt (Bright) smart-meter data",
  group: "energy",
  access: "authorised",
  territory: "GB",
  description: "Half-hourly and daily electricity and gas consumption from the DCC via the occupier's Bright (Glowmarkt) account: an alternative to n3rgy for residential and small-site portfolios where the occupier is engaged.",
  docsUrl: "https://glowmarkt.com/",
  termsUrl: "https://glowmarkt.com/terms",
  attribution: "Smart-meter data from Hildebrand Technology Ltd (Glowmarkt) under the meter occupier's consent.",
  licence: "consent_based",
  envVars: [
    { name: "GLOWMARKT_USERNAME", required: true, description: "Bright / Glowmarkt account e-mail of the consenting occupier (or a portal organisation account)." },
    { name: "GLOWMARKT_PASSWORD", required: true, description: "Password for that account; sent only to POST /auth. Server-side only." },
    { name: "GLOWMARKT_APPLICATION_ID", required: false, description: `applicationId header. Defaults to the public Bright application id ${DEFAULT_APPLICATION_ID} used by open-source clients; organisation users get their own.` },
    { name: "GLOWMARKT_API_BASE", required: false, description: `Override the API base (default ${DEFAULT_BASE}).` },
  ],
  status: "built_unverified",
  notes: [
    "Access route: the occupier installs the Bright app, links their smart meters (DCC consent) and shares the account or, for organisations, Hildebrand issues an organisation applicationId. Record the consent reference with every imported value.",
    "Endpoints, headers (applicationId + token) and response shapes follow the pyglowmarkt client and Glowmarkt API documentation; the default applicationId is the Bright app's public id used by those clients. None of this has been called live from this environment.",
    "Readings limits per request (Glowmarkt docs): 10 days at PT30M, 31 days at PT1H and P1D; this connector chunks longer ranges automatically and caps a single operation at 100 days of half-hourly or 366 days of daily data.",
    "Times are requested in UTC (offset=0) and reported as ISO instants; UK half-hourly settlement periods are local time, so BST days start at 23:00Z the previous evening. Values are kWh for electricity.consumption and gas.consumption (Glow converts gas volume to kWh); gas.consumption in m3 and *.cost resources in pence also exist.",
    "Data arrives from the DCC with a lag (typically the next day for half-hourly); a zero can be missing data rather than zero use, so the readings call uses nulls=1 and reports gaps.",
    "The auth token is cached in memory until its expiry (exp) and re-requested when 60 s or less remains.",
  ],
  healthCheck: async (ctx): Promise<HealthResult> => {
    const started = Date.now();
    try {
      const token = await getToken(ctx);
      return { ok: Boolean(token), detail: "Authenticated (token issued)", latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "virtual_entities",
      label: "List meters (virtual entities) and resources",
      description: "Virtual entities on the account (usually one per property) and their resources (electricity/gas consumption, cost, export) with the resourceId needed for readings.",
      params: [],
      async run(_params, ctx) {
        const ves = await listVirtualEntities(ctx);
        const rows = ves.flatMap((ve) =>
          (ve.resources ?? []).map((r) => ({
            ve_id: ve.veId,
            ve_name: ve.name ?? null,
            postcode: ve.postalCode ?? null,
            resource_id: r.resourceId,
            resource_name: r.name ?? null,
            classifier: r.classifier ?? null,
            base_unit: r.baseUnit ?? null,
            resource_type_id: r.resourceTypeId ?? null,
          })),
        );
        const classifiers = [...new Set(rows.map((r) => r.classifier).filter(Boolean))];
        return {
          summary: ves.length ? `${ves.length} virtual entit${ves.length === 1 ? "y" : "ies"} with ${rows.length} resource(s): ${classifiers.join(", ") || "no classifiers"}.` : "No virtual entities on this Glowmarkt account; the occupier has not linked a meter.",
          columns: ["ve_id", "ve_name", "postcode", "resource_id", "resource_name", "classifier", "base_unit", "resource_type_id"],
          rows,
          raw: ves,
          provenance: makeProvenance(definition, ctx, { dataset: "virtualentity", basis: rows.length ? "client_declared" : "unavailable" }),
        };
      },
    },
    {
      id: "readings",
      label: "Half-hourly or daily readings for a resource",
      description: "Consumption readings (kWh, m3 or pence depending on the resource) for a resource over a date range, chunked to the API's per-request limits.",
      params: [
        { name: "resource_id", label: "Resource ID", type: "string", required: true, placeholder: "8f0a7d2e-...", help: "From the virtual entities operation (electricity.consumption or gas.consumption)." },
        { name: "from", label: "From", type: "date", required: true, placeholder: "2026-08-01" },
        { name: "to", label: "To (inclusive)", type: "date", required: true, placeholder: "2026-08-31" },
        { name: "period", label: "Resolution", type: "select", default: "PT30M", options: [{ value: "PT30M", label: "Half-hourly (max 100 days per run)" }, { value: "PT1H", label: "Hourly" }, { value: "P1D", label: "Daily (max 366 days per run)" }] },
      ],
      async run(params, ctx) {
        const resourceId = String(params.resource_id);
        const from = String(params.from);
        const to = String(params.to);
        const period = String(params.period ?? "PT30M");
        assertRange(from, to, MAX_REQUEST_DAYS[period] ?? 31, `${period} readings`);
        const headers = await authHeaders(ctx);
        const chunks = chunkDays(from, to, RANGE_LIMIT_DAYS[period] ?? 31);
        const data: [number, number | null][] = [];
        let units: string | undefined;
        let name: string | undefined;
        let classifier: string | undefined;
        const rawChunks: unknown[] = [];
        for (const c of chunks) {
          const url = buildUrl(apiBase(ctx.env), `resource/${encodeURIComponent(resourceId)}/readings`, { from: `${c.from}T00:00:00`, to: `${c.to}T23:59:59`, period, offset: 0, function: "sum", nulls: 1 });
          const { data: r } = await fetchJson<ReadingsResponse>(ctx, url, { headers }, { timeoutMs: 30_000 });
          units = units ?? r?.units;
          name = name ?? r?.name;
          classifier = classifier ?? r?.classifier;
          rawChunks.push({ from: c.from, to: c.to, count: r?.data?.length ?? 0, units: r?.units });
          for (const d of r?.data ?? []) if (Array.isArray(d) && typeof d[0] === "number") data.push([d[0], typeof d[1] === "number" ? d[1] : null]);
        }
        const key = unitKey(units);
        const seen = new Set<number>();
        const rows = data
          .filter(([t]) => (seen.has(t) ? false : (seen.add(t), true)))
          .sort((a, b) => a[0] - b[0])
          .map(([t, v]) => ({ interval_start: epochToIso(t), [key]: v === null ? null : Math.round(v * 1000) / 1000, unit: units ?? null }));
        const columns = ["interval_start", key, "unit"];
        if (!rows.length) {
          return {
            summary: `No readings for resource ${resourceId} between ${from} and ${to} at ${period}.`,
            columns,
            rows: [],
            raw: { name, classifier, units, chunks: rawChunks },
            provenance: makeProvenance(definition, ctx, { dataset: "resource/readings", basis: "unavailable" }),
          };
        }
        const values = rows.map((r) => r[key] as number | null);
        const total = values.reduce<number>((a, v) => a + (v ?? 0), 0);
        const gaps = values.filter((v) => v === null).length;
        return {
          summary: `${name ?? classifier ?? "Resource"}: ${Math.round(total * 100) / 100} ${units ?? ""} over ${rows.length} ${period} interval(s) from ${from} to ${to}${gaps ? `, ${gaps} interval(s) with no data` : ""}${chunks.length > 1 ? ` (${chunks.length} API requests)` : ""}.`,
          columns,
          rows,
          raw: { name, classifier, units, chunks: rawChunks },
          provenance: makeProvenance(definition, ctx, { dataset: "resource/readings", basis: "measured" }),
          warnings: [
            "Intervals are UTC instants; UK settlement days run on local time. Null values are missing DCC data, not zero consumption.",
            ...(gaps ? [`${gaps} interval(s) missing: the DCC lag or a communications gap; re-run later before using the total for reporting.`] : []),
          ],
        };
      },
    },
  ],
});
