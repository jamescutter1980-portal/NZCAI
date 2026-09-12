import { defineIntegration, makeProvenance, type HealthResult, type OperationContext } from "../framework";
import { N3rgyClient } from "./client";
import { loadN3rgyConfig, N3RGY_HOSTS } from "./config";
import { dailyTotals, normaliseConsumption } from "./normalise";

function clientFor(ctx: OperationContext) {
  return new N3rgyClient({ config: loadN3rgyConfig(ctx.env), fetch: ctx.fetch, now: ctx.now });
}

export const definition = defineIntegration({
  id: "n3rgy",
  name: "n3rgy smart-meter data",
  group: "energy",
  access: "authorised",
  territory: "GB",
  description: "Consent-based half-hourly electricity and gas smart-meter data, keyed by MPAN or MPRN. The portal's first connector; consents, scheduled sync and stored readings live on their own pages.",
  docsUrl: "https://data.n3rgy.com/",
  attribution: "Energy data from https://data.n3rgy.com, delivered by n3rgy data Ltd.",
  licence: "consent_based",
  envVars: [
    { name: "N3RGY_API_KEY", required: true, description: "API key from the n3rgy customer self-service portal" },
    { name: "N3RGY_ENV", required: false, description: "sandbox (default) or live" },
    { name: "N3RGY_BASE_URL", required: false, description: `Override host; defaults ${N3RGY_HOSTS.sandbox} / ${N3RGY_HOSTS.live}` },
    { name: "N3RGY_HEALTH_MPXN", required: false, description: "An MPxN with active consent (or a sandbox sample) used by the health check" },
  ],
  status: "built_unverified",
  notes: [
    "Live retrieval requires an active consent record; see /consents. Sandbox MPxNs need none.",
    "The live host name and preferred auth header are unconfirmed; both Authorization and X-API-KEY are sent.",
    "Use /sync for scheduled pulls into the database; these operations are for ad-hoc checks.",
  ],
  async healthCheck(ctx): Promise<HealthResult> {
    const started = Date.now();
    const mpxn = ctx.env.N3RGY_HEALTH_MPXN?.trim();
    try {
      const client = clientFor(ctx);
      if (!mpxn) {
        const cfg = loadN3rgyConfig(ctx.env);
        const res = await ctx.fetch(cfg.baseUrl + "/", { headers: { authorization: cfg.apiKey, "x-api-key": cfg.apiKey }, signal: AbortSignal.timeout(15_000) });
        const reachable = res.status < 500;
        return { ok: reachable, detail: `${cfg.environment} host answered HTTP ${res.status}; set N3RGY_HEALTH_MPXN to test a real lookup`, latencyMs: Date.now() - started };
      }
      const listing = await client.listUtilities(mpxn);
      return { ok: true, detail: `${client.environment}: ${mpxn} lists ${listing.entries.join(", ") || "no utilities"}`, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
    }
  },
  operations: [
    {
      id: "utilities",
      label: "Utilities available for an MPxN",
      description: "Which fuels n3rgy will release for this supply point under the current key. A 403 means no consent.",
      params: [{ name: "mpxn", label: "MPAN / MPRN", type: "mpxn", required: true }],
      async run(params, ctx) {
        const client = clientFor(ctx);
        const listing = await client.listUtilities(String(params.mpxn));
        return {
          summary: `${params.mpxn}: ${listing.entries.length ? listing.entries.join(", ") : "nothing available"} (${client.environment}).`,
          columns: ["utility"],
          rows: listing.entries.map((u) => ({ utility: u })),
          raw: listing,
          provenance: makeProvenance(definition, ctx, { dataset: "listing", basis: "measured" }),
        };
      },
    },
    {
      id: "consumption",
      label: "Half-hourly consumption",
      description: "Daily totals for an MPxN over a short range. For stored, consent-gated data use the Readings page.",
      params: [
        { name: "mpxn", label: "MPAN / MPRN", type: "mpxn", required: true },
        { name: "utility", label: "Utility", type: "select", required: true, options: [{ value: "electricity", label: "Electricity" }, { value: "gas", label: "Gas" }] },
        { name: "start", label: "Start", type: "date", required: true },
        { name: "end", label: "End", type: "date", required: true },
      ],
      async run(params, ctx) {
        const client = clientFor(ctx);
        const query = {
          mpxn: String(params.mpxn),
          utility: params.utility as "electricity" | "gas",
          start: new Date(`${params.start}T00:00:00Z`),
          end: new Date(`${params.end}T23:59:00Z`),
        };
        const raw = await client.getConsumption(query);
        const readings = normaliseConsumption(query, raw);
        const daily = dailyTotals(readings);
        const total = daily.reduce((n, d) => n + d.value, 0);
        return {
          summary: `${readings.length} intervals, ${total.toFixed(1)} ${readings[0]?.unit ?? ""} over ${daily.length} days (${client.environment}).`,
          columns: ["date", "intervals", "value", "unit"],
          rows: daily.map((d) => ({ ...d })),
          raw: raw.chunks,
          provenance: makeProvenance(definition, ctx, { dataset: `${query.utility}/consumption/halfhour`, basis: "measured" }),
          warnings: raw.partial ? ["n3rgy returned partial content for at least one chunk."] : undefined,
        };
      },
    },
  ],
});
