import { buildUrl, fetchJson, makeProvenance, type IntegrationDefinition, type OperationContext, type OperationDefinition, type OperationResult, type ParamSpec } from "../framework";

/**
 * CKAN Action API (v3) helpers shared by the NESO, NGED and SSEN data portals.
 * Shapes follow the CKAN 2.x action API: { success, result }.
 */

export interface CkanResource {
  id: string;
  name?: string;
  description?: string;
  format?: string;
  url?: string;
  datastore_active?: boolean;
  last_modified?: string | null;
  created?: string | null;
}

export interface CkanPackage {
  id: string;
  name: string;
  title?: string;
  notes?: string;
  license_title?: string;
  license_id?: string;
  metadata_modified?: string;
  organization?: { title?: string; name?: string } | null;
  resources?: CkanResource[];
  tags?: { name: string }[];
}

export interface CkanPackageSearch {
  success: boolean;
  result: { count: number; results: CkanPackage[] };
}

export interface CkanDatastoreSearch {
  success: boolean;
  result: { total?: number; fields?: { id: string; type?: string }[]; records: Record<string, unknown>[] };
}

export interface CkanPortalConfig {
  /** e.g. https://api.neso.energy/api/3/action/ */
  base: string;
  /** Extra request headers (API key, user agent). */
  headers?: (env: Record<string, string | undefined>) => Record<string, string>;
  /** Portal-specific caveats appended to every result. */
  warnings?: string[];
  /** Optional curated dataset ids for a select-driven operation. Only include ids confirmed from documentation. */
  knownDatasets?: { value: string; label: string }[];
}

export const PACKAGE_COLUMNS = ["dataset_id", "dataset_title", "publisher", "licence", "modified", "resource_id", "resource_name", "format", "datastore", "resource_url"];

export function packageRows(pkgs: CkanPackage[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const p of pkgs) {
    const base = { dataset_id: p.name, dataset_title: p.title ?? p.name, publisher: p.organization?.title ?? null, licence: p.license_title ?? p.license_id ?? null, modified: p.metadata_modified ?? null };
    const res = p.resources ?? [];
    if (res.length === 0) rows.push({ ...base, resource_id: null, resource_name: null, format: null, datastore: false, resource_url: null });
    for (const r of res) rows.push({ ...base, resource_id: r.id, resource_name: r.name ?? null, format: r.format ?? null, datastore: Boolean(r.datastore_active), resource_url: r.url ?? null });
  }
  return rows;
}

export async function packageSearch(ctx: OperationContext, cfg: CkanPortalConfig, q: string, rows: number): Promise<CkanPackageSearch> {
  const url = buildUrl(cfg.base, "package_search", { q, rows });
  const { data } = await fetchJson<CkanPackageSearch>(ctx, url, { headers: cfg.headers?.(ctx.env) });
  return data;
}

export async function packageShow(ctx: OperationContext, cfg: CkanPortalConfig, id: string): Promise<{ success: boolean; result: CkanPackage | null }> {
  const url = buildUrl(cfg.base, "package_show", { id });
  const { data, status } = await fetchJson<{ success: boolean; result: CkanPackage | null }>(ctx, url, { headers: cfg.headers?.(ctx.env) }, { acceptStatuses: [404] });
  if (status === 404) return { success: false, result: null };
  return data;
}

export async function datastoreSearch(ctx: OperationContext, cfg: CkanPortalConfig, params: { resourceId: string; limit: number; offset?: number; q?: string }): Promise<CkanDatastoreSearch> {
  const url = buildUrl(cfg.base, "datastore_search", { resource_id: params.resourceId, limit: params.limit, offset: params.offset, q: params.q });
  const { data } = await fetchJson<CkanDatastoreSearch>(ctx, url, { headers: cfg.headers?.(ctx.env) }, { acceptStatuses: [404] });
  return data;
}

/**
 * Builds the standard CKAN operations (search datasets, list a dataset's resources, query a datastore resource)
 * for a portal. `def` is a lazy getter because the definition object references these operations.
 */
export function ckanOperations(def: () => IntegrationDefinition, cfg: CkanPortalConfig): OperationDefinition[] {
  const warn = (extra: string[] = []) => [...(cfg.warnings ?? []), ...extra];
  const datasetParam: ParamSpec = {
    name: "dataset_id",
    label: "Dataset id",
    type: "string",
    required: true,
    placeholder: "historic-demand-data",
    help: "The dataset 'name' slug from the portal URL or from a dataset search result.",
  };
  const ops: OperationDefinition[] = [
    {
      id: "search_datasets",
      label: "Search datasets",
      description: "Full-text search of the portal catalogue. Returns one row per resource (file or table) so resource ids can be passed to 'Query a resource table'.",
      params: [
        { name: "q", label: "Search", type: "string", required: true, placeholder: "demand" },
        { name: "rows", label: "Max datasets", type: "integer", default: 10, min: 1, max: 50 },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const data = await packageSearch(ctx, cfg, String(params.q), Number(params.rows ?? 10));
        const pkgs = data.result?.results ?? [];
        const rows = packageRows(pkgs);
        const d = def();
        if (pkgs.length === 0) {
          return { summary: `No datasets matched "${params.q}".`, columns: PACKAGE_COLUMNS, rows: [], raw: data, provenance: makeProvenance(d, ctx, { dataset: "package_search", basis: "unavailable" }), warnings: warn() };
        }
        return {
          summary: `${data.result.count} datasets match "${params.q}"; showing ${pkgs.length} with ${rows.length} resources.`,
          columns: PACKAGE_COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(d, ctx, { dataset: "package_search", basis: "measured" }),
          warnings: warn(),
        };
      },
    },
    {
      id: "dataset_resources",
      label: "List a dataset's resources",
      description: "Metadata and resources (files, datastore tables) for one dataset id.",
      params: [datasetParam],
      async run(params, ctx): Promise<OperationResult> {
        const data = await packageShow(ctx, cfg, String(params.dataset_id));
        const d = def();
        if (!data.result) {
          return { summary: `Dataset ${params.dataset_id} not found.`, columns: PACKAGE_COLUMNS, rows: [], raw: data, provenance: makeProvenance(d, ctx, { dataset: "package_show", basis: "unavailable" }), warnings: warn() };
        }
        const rows = packageRows([data.result]);
        const tables = rows.filter((r) => r.datastore).length;
        return {
          summary: `${data.result.title ?? data.result.name}: ${rows.length} resources, ${tables} queryable in the datastore. Last modified ${data.result.metadata_modified ?? "unknown"}.`,
          columns: PACKAGE_COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(d, ctx, { dataset: "package_show", basis: "measured" }),
          warnings: warn(),
          links: data.result.resources?.filter((r) => r.url).map((r) => ({ label: `${r.name ?? r.id} (${r.format ?? "file"})`, url: r.url as string })),
        };
      },
    },
    {
      id: "query_resource",
      label: "Query a resource table",
      description: "Rows from a datastore-enabled resource, optionally filtered by a full-text term. Use the resource id from a dataset search.",
      params: [
        { name: "resource_id", label: "Resource id", type: "string", required: true, placeholder: "bb44a1b5-75b1-4db2-8491-257f23385006", help: "UUID of a resource with datastore = true." },
        { name: "q", label: "Full-text filter", type: "string", required: false, placeholder: "2025" },
        { name: "limit", label: "Max rows", type: "integer", default: 100, min: 1, max: 100 },
        { name: "offset", label: "Offset", type: "integer", default: 0, min: 0 },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const data = await datastoreSearch(ctx, cfg, { resourceId: String(params.resource_id), limit: Number(params.limit ?? 100), offset: Number(params.offset ?? 0), q: params.q ? String(params.q) : undefined });
        const d = def();
        const records = data.result?.records ?? [];
        const columns = data.result?.fields?.map((f) => f.id).filter((c) => c !== "_id" && c !== "_full_text") ?? Object.keys(records[0] ?? {});
        if (!data.success || records.length === 0) {
          return { summary: `No rows returned for resource ${params.resource_id}${data.success ? "" : " (not found or not a datastore resource)"}.`, columns, rows: [], raw: data, provenance: makeProvenance(d, ctx, { dataset: "datastore_search", basis: "unavailable" }), warnings: warn() };
        }
        const rows = records.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null])));
        return {
          summary: `${rows.length} of ${data.result.total ?? "?"} rows from resource ${params.resource_id}.`,
          columns,
          rows,
          raw: data,
          provenance: makeProvenance(d, ctx, { dataset: `datastore:${params.resource_id}`, basis: "measured" }),
          warnings: warn(["Column meanings and units are defined by the dataset publisher; check the dataset page before using values in calculations."]),
        };
      },
    },
  ];
  if (cfg.knownDatasets && cfg.knownDatasets.length > 0) {
    ops.push({
      id: "known_dataset",
      label: "Open a well-known dataset",
      description: "Resources for datasets the portal team has confirmed by id. Pick one, then query a resource table with the resource id.",
      params: [{ name: "dataset", label: "Dataset", type: "select", required: true, options: cfg.knownDatasets }],
      async run(params, ctx) {
        return ops[1].run({ dataset_id: params.dataset }, ctx);
      },
    });
  }
  return ops;
}
