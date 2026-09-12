/**
 * Minimal client for the Opendatasoft Explore API v2.1, which every DNO
 * portal in the registry speaks.
 *
 *   records  - paginated, capped at 100/page and 10k total. Used for probing.
 *   exports  - unpaginated full dump. Used for real ingestion.
 *
 * Docs: https://help.opendatasoft.com/apis/ods-explore-v2/
 */

export interface OdsField {
  name: string;
  type: string;
  label?: string;
}

export interface OdsDataset {
  dataset_id: string;
  fields: OdsField[];
  records_count?: number;
}

export type OdsRecord = Record<string, unknown>;

const USER_AGENT = "NZC-AI/0.1 (+grid capacity screening)";

async function getJson<T>(url: string, timeoutMs = 60_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `HTTP ${res.status} ${res.statusText} for ${url}${body ? ` - ${body.slice(0, 200)}` : ""}`,
      );
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function base(host: string): string {
  return `https://${host}/api/explore/v2.1/catalog/datasets`;
}

/** Resolve a dataset and return its declared field list. Throws if absent. */
export async function describeDataset(
  host: string,
  slug: string,
): Promise<OdsDataset> {
  const payload = await getJson<{
    dataset_id?: string;
    fields?: OdsField[];
    metas?: { default?: { records_count?: number } };
  }>(`${base(host)}/${encodeURIComponent(slug)}`, 30_000);

  return {
    dataset_id: payload.dataset_id ?? slug,
    fields: payload.fields ?? [],
    records_count: payload.metas?.default?.records_count,
  };
}

/** Search a portal's catalogue - used to suggest a slug when one 404s. */
export async function searchDatasets(
  host: string,
  term: string,
): Promise<string[]> {
  const url =
    `${base(host)}?limit=20&where=` +
    encodeURIComponent(`search(dataset_id, "${term}")`);
  const payload = await getJson<{ results?: { dataset_id?: string }[] }>(
    url,
    30_000,
  );
  return (payload.results ?? [])
    .map((r) => r.dataset_id)
    .filter((id): id is string => typeof id === "string");
}

/** First page of records. Cheap probe of real field values. */
export async function sampleRecords(
  host: string,
  slug: string,
  limit = 5,
): Promise<OdsRecord[]> {
  const url = `${base(host)}/${encodeURIComponent(slug)}/records?limit=${limit}`;
  const payload = await getJson<{ results?: OdsRecord[] }>(url, 30_000);
  return payload.results ?? [];
}

/** Full dataset export. No 10k ceiling, unlike the records endpoint. */
export async function exportAll(
  host: string,
  slug: string,
): Promise<OdsRecord[]> {
  const url = `${base(host)}/${encodeURIComponent(slug)}/exports/json`;
  const payload = await getJson<OdsRecord[]>(url, 180_000);
  if (!Array.isArray(payload)) {
    throw new Error(`Export for ${slug} did not return an array`);
  }
  return payload;
}
