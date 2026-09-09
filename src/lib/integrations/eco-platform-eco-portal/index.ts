import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type EnvLike, type OperationContext, type OperationResult } from "../framework";
import { a1a3Total, EPD_WARNINGS, gwpModuleRows, mapProcessListEntry, primaryGwp, PROCESS_LIST_COLUMNS, summariseProcess, type ProcessListPage, type ProcessListRow } from "../_shared/ilcd";

/**
 * ECO Platform ECO Portal: the European aggregation of verified EPDs from
 * member programme operators, served by a soda4LCA node.
 *
 *   GET /processes?search=true&name=<text>&format=json&pageSize=&startIndex=&distributed=true&virtual=true&metaDataOnly=false&lang=en
 *   GET /processes/{uuid}?format=json&view=extended&lang=en&version=
 *
 * Auth: Authorization: Bearer <ECO_PORTAL_TOKEN> (token from the ECO Portal
 * user account). The portal is a virtual node: each hit carries the URI of
 * the originating operator node, which may need its own credentials.
 * Endpoint shapes follow the soda4LCA service API and public clients; not
 * exercised live from this environment.
 */

const BASE = "https://data.eco-platform.org/resource";
const HOST = new URL(BASE).host;

function headers(env: EnvLike, targetUrl: string): Record<string, string> {
  const token = env.ECO_PORTAL_TOKEN?.trim();
  if (!token) throw new Error("ECO_PORTAL_TOKEN is not set");
  // Never send the ECO Portal token to a different host (originating nodes have their own tokens).
  return new URL(targetUrl).host === HOST ? { authorization: `Bearer ${token}` } : {};
}

export function epdDetailResult(def: typeof definition, ctx: OperationContext, process: unknown, dataset: string, sourceUrl: string): OperationResult {
  const s = summariseProcess(process);
  const gwp = primaryGwp(s.indicators);
  const rows = gwpModuleRows(s);
  const du = s.declaredUnit;
  const declared = du.amount !== null && du.unit ? `${du.amount} ${du.unit}` : (du.unit ?? "unknown unit");
  const total = a1a3Total(gwp);
  const warnings = [...EPD_WARNINGS];
  if (!gwp) warnings.unshift("No GWP-total (or A1-era GWP) indicator found in this dataset; other GWP sub-indicators are listed if present.");
  if (s.validUntil && s.validUntil < ctx.now().getUTCFullYear()) warnings.unshift(`Dataset validity ended ${s.validUntil}.`);
  const summary = !s.uuid && !s.name
    ? "Dataset not found or not readable."
    : `${s.name ?? s.uuid} (${s.subType ?? "EPD"}, ${s.geography ?? "geography n/a"}, valid until ${s.validUntil ?? "n/a"}): ${gwp ? `${gwp.kind} A1-A3 = ${total ?? "not declared"} ${gwp.unit ?? "kg CO2 eq."}` : "no GWP indicator"} per ${declared}.`;
  return {
    summary,
    columns: ["indicator", "module", "scenario", "value_kgco2e", "availability", "unit", "declared_unit", "raw"],
    rows: rows.map((r) => ({ ...r })),
    raw: { source: sourceUrl, summary: s },
    provenance: makeProvenance(def, ctx, { dataset, basis: rows.length ? "measured" : "unavailable", version: [s.uuid, s.version].filter(Boolean).join(" v") || undefined }),
    warnings,
    links: [{ label: "Dataset", url: sourceUrl }],
  };
}

export function listResult(def: typeof definition, ctx: OperationContext, page: ProcessListPage, dataset: string, query: string, version?: string): OperationResult {
  const rows = (page.data ?? []).map(mapProcessListEntry).filter((r): r is ProcessListRow => r !== null);
  const total = page.totalCount ?? rows.length;
  return {
    summary: total === 0 ? `No EPDs match "${query}".` : `${total} EPD(s) match "${query}"; showing ${rows.length} from ${(page.startIndex ?? 0) + 1}.`,
    columns: PROCESS_LIST_COLUMNS,
    rows: rows.map((r) => ({ ...r })),
    raw: page,
    provenance: makeProvenance(def, ctx, { dataset, basis: rows.length ? "measured" : "unavailable", version }),
    warnings: ["Search hits are dataset headers; open the detail operation for GWP by module, declared unit and validity."],
  };
}

export const definition = defineIntegration({
  id: "eco-platform-eco-portal",
  name: "ECO Platform ECO Portal (EPDs)",
  group: "embodied",
  access: "open_key",
  territory: "Europe",
  description: "Search verified Environmental Product Declarations aggregated from European programme operators (EN 15804) and read GWP by life-cycle module with the declared unit, geography and validity.",
  docsUrl: "https://www.eco-platform.org/epd-data.html",
  attribution: "EPD data via ECO Platform ECO Portal; each dataset © its programme operator and declaration owner. Dataset UUID and version as recorded.",
  licence: "restricted",
  envVars: [{ name: "ECO_PORTAL_TOKEN", required: true, description: "Bearer token generated in the ECO Portal user account (free registration)." }],
  status: "built_unverified",
  notes: [
    "Register at data.eco-platform.org, then generate an API token in the user profile; tokens expire and must be renewed. The token is sent only to data.eco-platform.org, never to originating nodes.",
    "The ECO Portal is a virtual node: search hits include uri and node of the originating operator (IBU, EPD Norway, BRE, etc.). If the detail call on the portal fails for a hit, pass its uri to the detail operation; some nodes need their own credentials.",
    "Endpoint parameters (search=true, name, format=json, pageSize, startIndex, distributed=true, virtual=true, view=extended) follow the soda4LCA service API; the JSON extraction of LCIAResults/anies per module is confirmed from open-source clients, not from a live call here.",
    "Values in the file are as declared by the EPD (basis 'measured' = published, not remeasured). 'ND'/'MNA' are returned as not declared, never 0.",
    ...EPD_WARNINGS,
    "Terms: ECO Portal data is for use in LCA and building assessment; check ECO Platform terms before bulk redistribution of datasets.",
  ],
  healthCheck: simpleHealth(
    () => buildUrl(BASE, "processes", { search: true, format: "json", pageSize: 1 }),
    (env) => ({ headers: headers(env, BASE) }),
  ),
  operations: [
    {
      id: "search",
      label: "Search EPDs by name",
      description: "Datasets whose name matches the text, with owner, geography, classification and validity.",
      params: [
        { name: "name", label: "Product name contains", type: "string", required: true, placeholder: "ready-mix concrete" },
        { name: "valid_until", label: "Valid until at least (year)", type: "integer", min: 2000, max: 2100, help: "Optional: only datasets valid until this year or later." },
        { name: "page_size", label: "Results", type: "integer", default: 25, min: 1, max: 100 },
        { name: "start_index", label: "Start index", type: "integer", default: 0, min: 0, max: 100000 },
      ],
      async run(params, ctx) {
        const url = buildUrl(BASE, "processes", {
          search: true,
          distributed: true,
          virtual: true,
          metaDataOnly: false,
          format: "json",
          lang: "en",
          name: String(params.name),
          validUntil: params.valid_until as number | undefined,
          pageSize: params.page_size as number,
          startIndex: params.start_index as number,
        });
        const { data } = await fetchJson<ProcessListPage>(ctx, url, { headers: headers(ctx.env, url) });
        return listResult(definition, ctx, data, "processes", String(params.name));
      },
    },
    {
      id: "detail",
      label: "EPD detail: GWP by module",
      description: "Full dataset for one UUID: GWP-total (and sub-indicators) per life-cycle module, declared unit, geography and validity.",
      params: [
        { name: "uuid", label: "Dataset UUID", type: "string", required: true, placeholder: "8be9edb5-c5b9-4be1-bfb8-b096f24a183b" },
        { name: "version", label: "Dataset version", type: "string", placeholder: "00.01.000", help: "Optional; latest version when blank." },
        { name: "uri", label: "Originating node URI", type: "string", placeholder: "https://ibudata.lca-data.com/resource/processes/...", help: "Optional: the uri from a search hit, used instead of the portal when the dataset lives on a member node (https only)." },
      ],
      async run(params, ctx) {
        const uuid = String(params.uuid).trim();
        if (!/^[0-9a-f-]{36}$/i.test(uuid)) throw new Error("uuid must be a UUID");
        let url: string;
        if (params.uri) {
          const u = new URL(String(params.uri));
          if (u.protocol !== "https:") throw new Error("uri must be https");
          u.searchParams.set("format", "json");
          u.searchParams.set("view", "extended");
          u.searchParams.set("lang", "en");
          if (params.version) u.searchParams.set("version", String(params.version));
          url = u.toString();
        } else {
          url = buildUrl(BASE, `processes/${uuid}`, { format: "json", view: "extended", lang: "en", version: params.version as string | undefined });
        }
        const { data, status } = await fetchJson<unknown>(ctx, url, { headers: headers(ctx.env, url) }, { acceptStatuses: [404] });
        if (status === 404) {
          return { summary: `Dataset ${uuid} not found on ${new URL(url).host}.`, rows: [], columns: ["indicator", "module", "value_kgco2e"], provenance: makeProvenance(definition, ctx, { dataset: "processes", basis: "unavailable" }) };
        }
        const res = epdDetailResult(definition, ctx, data, "processes", url);
        if (new URL(url).host !== HOST) res.warnings = [`Fetched from member node ${new URL(url).host} without the ECO Portal token.`, ...(res.warnings ?? [])];
        return res;
      },
    },
  ],
});
