import { defineIntegration, makeProvenance, simpleHealth, type OperationContext, type OperationResult } from "../framework";
import { CATALOG_COLUMNS, catalogRows, fetchRecords, odsHeaders, odsTextSearch, searchCatalog } from "../_shared/opendatasoft";

/**
 * Distribution network operator open data portals on Opendatasoft (Explore API v2.1). Hosts and the
 * "Authorization: Apikey" header are from Opendatasoft's public API reference and open-source clients of the
 * UKPN portal; not exercised live here.
 */

export const OPERATORS: Record<string, { label: string; host: string; area: string }> = {
  ukpn: { label: "UK Power Networks", host: "https://ukpowernetworks.opendatasoft.com", area: "London, South East and East of England" },
  npg: { label: "Northern Powergrid", host: "https://northernpowergrid.opendatasoft.com", area: "North East England and Yorkshire" },
  spen: { label: "SP Energy Networks", host: "https://spenergynetworks.opendatasoft.com", area: "Central and southern Scotland, Merseyside, Cheshire and North Wales" },
  enwl: { label: "Electricity North West", host: "https://electricitynorthwest.opendatasoft.com", area: "North West England" },
};

const ENV_KEY = "DNO_OPENDATASOFT_API_KEY";
const operatorParam = { name: "operator", label: "Network operator", type: "select" as const, required: true, options: Object.entries(OPERATORS).map(([value, o]) => ({ value, label: `${o.label} (${o.area})` })) };

const CAPACITY_WARNING = "Capacity, headroom and heat-map datasets are indicative planning views published for information. They are never a connection offer; only a formal connection application confirms available capacity.";

function operator(params: Record<string, unknown>) {
  const op = OPERATORS[String(params.operator)];
  if (!op) throw new Error(`Unknown operator ${params.operator}`);
  return op;
}

async function catalogOp(params: Record<string, unknown>, ctx: OperationContext, terms: string[], limit: number, dataset: string, extraWarnings: string[] = []): Promise<OperationResult> {
  const op = operator(params);
  const where = terms.length ? odsTextSearch(terms) : undefined;
  const data = await searchCatalog(ctx, op.host, odsHeaders(ctx.env, ENV_KEY), where, limit);
  const rows = catalogRows(data.results ?? []);
  if (rows.length === 0) return { summary: `No ${op.label} datasets matched ${terms.map((t) => `"${t}"`).join(" or ") || "the catalogue"}.`, columns: CATALOG_COLUMNS, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset, basis: "unavailable" }), warnings: extraWarnings };
  return {
    summary: `${data.total_count} ${op.label} datasets match ${terms.map((t) => `"${t}"`).join(" or ") || "the catalogue"}; showing ${rows.length}, newest first.`,
    columns: CATALOG_COLUMNS,
    rows,
    raw: data,
    provenance: makeProvenance(definition, ctx, { dataset, basis: "measured" }),
    warnings: extraWarnings,
    links: rows.map((r) => ({ label: String(r.title), url: `${op.host}/explore/dataset/${r.dataset_id}/` })),
  };
}

export const definition = defineIntegration({
  id: "dno-open-data",
  name: "DNO open data portals (Opendatasoft)",
  group: "grid",
  access: "open",
  territory: "GB (UKPN, Northern Powergrid, SP Energy Networks and Electricity North West licence areas)",
  description: "Open data from four distribution network operators on Opendatasoft: substation and feeder capacity/headroom, connection queues, flexibility zones, faults, and network assets. Search a portal's catalogue, fetch dataset records with an optional ODSQL filter, and find capacity datasets.",
  docsUrl: "https://help.opendatasoft.com/apis/ods-explore-v2/",
  attribution: "Contains data from the UK Power Networks, Northern Powergrid, SP Energy Networks and Electricity North West open data portals, © the respective licensee, used under each dataset's stated licence.",
  licence: "OGL",
  envVars: [{ name: ENV_KEY, required: false, description: "Optional Opendatasoft API key (sent as 'Authorization: Apikey <key>'). Not needed for public datasets; some portals key-gate high-volume records endpoints." }],
  status: "built_unverified",
  notes: [
    "Licence bucket OGL: most datasets carry OGL v3.0, CC BY 4.0 or the operator's own open licence, but some are restricted. Each result row shows the dataset's stated licence; check it before redistribution.",
    "Explore API v2.1 catalogue search uses an ODSQL 'where' clause with a quoted string literal for full-text search. The exact behaviour of that literal across these four portals is unverified; 'Search datasets' may need tuning after a live call.",
    "Records endpoints are capped at 100 rows per call; use 'where' and 'select' (ODSQL) to narrow. Opendatasoft also enforces per-portal daily quotas for anonymous callers.",
    CAPACITY_WARNING,
    "NGED and SSEN use CKAN portals and have their own connectors (nged-connected-data, ssen-data-portal).",
  ],
  healthCheck: simpleHealth(`${OPERATORS.ukpn.host}/api/explore/v2.1/catalog/datasets?limit=1`),
  operations: [
    {
      id: "search_datasets",
      label: "Search datasets on an operator's portal",
      description: "Full-text search of one DNO portal catalogue. Returns dataset ids to pass to 'Fetch dataset records'.",
      params: [
        operatorParam,
        { name: "search", label: "Search term", type: "string", required: false, placeholder: "substation headroom", help: "Leave blank to list the newest datasets." },
        { name: "limit", label: "Max datasets", type: "integer", default: 20, min: 1, max: 50 },
      ],
      async run(params, ctx) {
        const terms = params.search ? String(params.search).split(/\s*,\s*/).filter(Boolean) : [];
        return catalogOp(params, ctx, terms, Number(params.limit ?? 20), "catalog/datasets");
      },
    },
    {
      id: "capacity_datasets",
      label: "Find connection capacity and headroom datasets",
      description: "Lists datasets on the chosen operator's portal about network capacity, headroom and connection queues.",
      params: [operatorParam, { name: "limit", label: "Max datasets", type: "integer", default: 30, min: 1, max: 50 }],
      async run(params, ctx) {
        return catalogOp(params, ctx, ["capacity", "headroom"], Number(params.limit ?? 30), "catalog/datasets (capacity)", [CAPACITY_WARNING]);
      },
    },
    {
      id: "dataset_records",
      label: "Fetch dataset records",
      description: "Rows from one dataset, optionally filtered with an ODSQL where clause (e.g. postcode LIKE \"SW1A\" or headroom_mva > 5).",
      params: [
        operatorParam,
        { name: "dataset_id", label: "Dataset id", type: "string", required: true, placeholder: "ukpn-grid-supply-points-overview", help: "From a catalogue search or the portal URL." },
        { name: "where", label: "ODSQL where", type: "string", required: false, placeholder: 'dno = "EPN"' },
        { name: "select", label: "ODSQL select", type: "string", required: false, placeholder: "name, headroom_mva", help: "Comma-separated field list; blank returns all fields." },
        { name: "order_by", label: "Order by", type: "string", required: false, placeholder: "-modified" },
        { name: "limit", label: "Max rows", type: "integer", default: 100, min: 1, max: 100 },
        { name: "offset", label: "Offset", type: "integer", default: 0, min: 0 },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const op = operator(params);
        const datasetId = String(params.dataset_id);
        const { data } = await fetchRecords(ctx, op.host, odsHeaders(ctx.env, ENV_KEY), datasetId, {
          where: params.where ? String(params.where) : undefined,
          select: params.select ? String(params.select) : undefined,
          order_by: params.order_by ? String(params.order_by) : undefined,
          limit: Number(params.limit ?? 100),
          offset: Number(params.offset ?? 0),
        });
        const results = data?.results ?? [];
        const columns = Object.keys(results[0] ?? {});
        const warnings = [CAPACITY_WARNING, "Field names and units are defined by the operator; read the dataset page before using values in calculations."];
        if (!data) return { summary: `Dataset ${datasetId} not found on ${op.label}.`, columns, rows: [], raw: null, provenance: makeProvenance(definition, ctx, { dataset: datasetId, basis: "unavailable" }), warnings };
        if (results.length === 0) return { summary: `No records in ${datasetId} on ${op.label}${params.where ? ` for where ${params.where}` : ""}.`, columns, rows: [], raw: data, provenance: makeProvenance(definition, ctx, { dataset: datasetId, basis: "unavailable" }), warnings };
        const rows = results.map((r) => Object.fromEntries(columns.map((c) => [c, typeof r[c] === "object" && r[c] !== null ? JSON.stringify(r[c]) : (r[c] ?? null)])));
        return {
          summary: `${rows.length} of ${data.total_count} records from ${datasetId} (${op.label})${params.where ? ` where ${params.where}` : ""}.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: datasetId, basis: "measured" }),
          warnings,
          links: [{ label: `${datasetId} on ${op.label}`, url: `${op.host}/explore/dataset/${datasetId}/` }],
        };
      },
    },
  ],
});
