import { buildUrl, fetchJson, type OperationContext } from "../framework";

/**
 * Opendatasoft Explore API v2.1 helpers (UKPN, Northern Powergrid, SP Energy Networks, Electricity North West).
 * Shapes follow the public Explore v2.1 reference: catalog/datasets and catalog/datasets/{id}/records both return
 * { total_count, results: [...] }.
 */

export interface OdsDatasetMeta {
  dataset_id: string;
  has_records?: boolean;
  metas?: { default?: { title?: string; description?: string; modified?: string; publisher?: string; records_count?: number; keyword?: string[]; license?: string; theme?: string[] } };
  fields?: { name: string; label?: string; type?: string }[];
}

export interface OdsCatalog {
  total_count: number;
  results: OdsDatasetMeta[];
}

export interface OdsRecords {
  total_count: number;
  results: Record<string, unknown>[];
}

export function odsHeaders(env: Record<string, string | undefined>, envVar: string): Record<string, string> {
  const key = env[envVar]?.trim();
  return key ? { Authorization: `Apikey ${key}` } : {};
}

/** ODSQL full-text search: a bare double-quoted string literal in `where` searches every field. */
export function odsTextSearch(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

export function catalogUrl(host: string, query: Record<string, string | number | undefined>): string {
  return buildUrl(host, "api/explore/v2.1/catalog/datasets", query);
}

export function recordsUrl(host: string, datasetId: string, query: Record<string, string | number | undefined>): string {
  return buildUrl(host, `api/explore/v2.1/catalog/datasets/${encodeURIComponent(datasetId)}/records`, query);
}

export async function searchCatalog(ctx: OperationContext, host: string, headers: Record<string, string>, where: string | undefined, limit: number): Promise<OdsCatalog> {
  const { data } = await fetchJson<OdsCatalog>(ctx, catalogUrl(host, { where, limit, order_by: "-modified" }), { headers });
  return data;
}

export async function fetchRecords(ctx: OperationContext, host: string, headers: Record<string, string>, datasetId: string, query: { where?: string; select?: string; order_by?: string; limit: number; offset?: number }): Promise<{ data: OdsRecords | null; status: number }> {
  const { data, status } = await fetchJson<OdsRecords>(ctx, recordsUrl(host, datasetId, query), { headers }, { acceptStatuses: [404] });
  return { data: status === 404 ? null : data, status };
}

export const CATALOG_COLUMNS = ["dataset_id", "title", "publisher", "modified", "records", "licence", "keywords", "description"];

export function catalogRows(results: OdsDatasetMeta[]): Record<string, unknown>[] {
  return results.map((r) => {
    const m = r.metas?.default ?? {};
    return {
      dataset_id: r.dataset_id,
      title: m.title ?? r.dataset_id,
      publisher: m.publisher ?? null,
      modified: m.modified ?? null,
      records: m.records_count ?? null,
      licence: m.license ?? null,
      keywords: (m.keyword ?? []).join(", "),
      description: (m.description ?? "").replace(/<[^>]+>/g, "").slice(0, 300),
    };
  });
}
