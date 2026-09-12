import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationContext } from "../framework";
import { assertRange } from "../_shared/dates";

/**
 * Contracts Finder (Cabinet Office) OCDS notice search, with Find a Tender
 * (FTS) release packages as a second operation. Both publish Open
 * Contracting Data Standard releases without authentication.
 *
 * Built from the Contracts Finder API documentation page listing
 * (publishedFrom, publishedTo, stages, orderBy, order, size, page) and
 * open-source OCDS collectors (kingfisher-collect, bluetail); no live call
 * has been made from this codebase. A server-side keyword parameter is not
 * documented, so keyword filtering happens on the fetched page(s).
 */

export const CF_BASE = "https://www.contractsfinder.service.gov.uk";
export const FTS_BASE = "https://www.find-tender.service.gov.uk";

interface Value {
  amount?: number;
  currency?: string;
}
interface Release {
  ocid?: string;
  id?: string;
  date?: string;
  tag?: string[];
  buyer?: { name?: string; id?: string };
  tender?: {
    id?: string;
    title?: string;
    description?: string;
    status?: string;
    value?: Value;
    minValue?: Value;
    procurementMethod?: string;
    mainProcurementCategory?: string;
    tenderPeriod?: { startDate?: string; endDate?: string };
    items?: { classification?: { id?: string; description?: string } }[];
    documents?: { url?: string; documentType?: string }[];
  };
  awards?: { id?: string; date?: string; value?: Value; suppliers?: { name?: string }[] }[];
  planning?: { budget?: { amount?: Value } };
}
interface CfResult {
  uri?: string;
  publishedDate?: string;
  releases?: Release[];
}
interface CfSearch {
  hitsCount?: number;
  maxPage?: number;
  results?: CfResult[];
}
interface FtsPackage {
  uri?: string;
  publishedDate?: string;
  releases?: Release[];
  links?: { next?: string };
}

export const COLUMNS = ["published", "buyer", "title", "stage", "status", "value", "currency", "tender_closes", "award_date", "suppliers", "category", "ocid", "notice_url"];

export function releaseRow(r: Release, published?: string, noticeUrl?: string) {
  const award = r.awards?.[0];
  const value = r.tender?.value ?? award?.value ?? r.planning?.budget?.amount;
  return {
    published: published ?? r.date ?? null,
    buyer: r.buyer?.name ?? null,
    title: r.tender?.title ?? null,
    stage: (r.tag ?? []).join(","),
    status: r.tender?.status ?? null,
    value: value?.amount ?? null,
    currency: value?.currency ?? null,
    tender_closes: r.tender?.tenderPeriod?.endDate ?? null,
    award_date: award?.date ?? null,
    suppliers: (r.awards ?? []).flatMap((a) => (a.suppliers ?? []).map((s) => s.name ?? "")).filter(Boolean).join("; "),
    category: r.tender?.mainProcurementCategory ?? r.tender?.items?.[0]?.classification?.description ?? null,
    ocid: r.ocid ?? null,
    notice_url: noticeUrl ?? null,
  };
}

export function matchesKeyword(r: Release, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return true;
  const hay = [r.tender?.title, r.tender?.description, r.buyer?.name, ...(r.awards ?? []).flatMap((a) => (a.suppliers ?? []).map((s) => s.name))].filter(Boolean).join(" ").toLowerCase();
  return k.split(/\s+/).every((t) => hay.includes(t));
}

const STAGES = [
  { value: "", label: "All stages" },
  { value: "tender", label: "Tender (open opportunities)" },
  { value: "award", label: "Award" },
  { value: "planning", label: "Planning / early engagement" },
  { value: "implementation", label: "Implementation" },
];

async function fetchWithRetryNote<T>(ctx: OperationContext, url: string) {
  return fetchJson<T>(ctx, url, {}, { timeoutMs: 30_000 });
}

export const definition = defineIntegration({
  id: "contracts-finder",
  name: "Contracts Finder and Find a Tender (OCDS)",
  group: "company",
  access: "open",
  territory: "UK",
  description: "Public-sector procurement notices as Open Contracting Data Standard releases: buyer, title, value, tender and award dates and winning suppliers. Contracts Finder covers England-based contracts over GBP 12k (central) / GBP 30k (wider public sector); Find a Tender covers above-threshold notices UK-wide.",
  docsUrl: "https://www.contractsfinder.service.gov.uk/apidocumentation/Notices/1/GET-Published-Notice-OCDS-Search",
  termsUrl: "https://www.contractsfinder.service.gov.uk/apidocumentation",
  attribution: "Contains public sector information licensed under the Open Government Licence v3.0. Source: Cabinet Office, Contracts Finder and Find a Tender.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "Contracts Finder has undocumented request throttling; on HTTP 403 the documentation asks for a 5-minute pause. Requests are limited here to one page of up to 100 releases per call.",
    "No server-side keyword parameter is documented for the OCDS search, so the keyword filter is applied to the releases in the fetched page; widen the date window or page through for exhaustive searches.",
    "Since February 2025 (Procurement Act 2023) new notices are published on Find a Tender; Contracts Finder holds legacy notices and some below-threshold notices. Search both.",
    "Values are as published by the buyer (estimated at tender, actual at award) and may exclude VAT.",
  ],
  healthCheck: simpleHealth(buildUrl(CF_BASE, "Published/Notices/OCDS/Search", { publishedFrom: "2026-01-01", publishedTo: "2026-01-02", size: 1 })),
  operations: [
    {
      id: "search",
      label: "Contracts Finder notices by keyword and date",
      description: "Notices published in a date window (up to 92 days), optionally filtered to a stage and keyword.",
      params: [
        { name: "published_from", label: "Published from", type: "date", required: true, placeholder: "2026-08-01" },
        { name: "published_to", label: "Published to", type: "date", required: true, placeholder: "2026-08-31" },
        { name: "keyword", label: "Keyword(s)", type: "string", placeholder: "solar PV", help: "All words must appear in the title, description, buyer or supplier names." },
        { name: "stage", label: "Stage", type: "select", options: STAGES, default: "" },
        { name: "size", label: "Releases per page", type: "integer", default: 100, min: 1, max: 100 },
        { name: "page", label: "Page", type: "integer", default: 1, min: 1, max: 1000 },
      ],
      async run(params, ctx) {
        const from = String(params.published_from);
        const to = String(params.published_to);
        assertRange(from, to, 92, "published window");
        const url = buildUrl(CF_BASE, "Published/Notices/OCDS/Search", {
          publishedFrom: from,
          publishedTo: to,
          stages: params.stage ? String(params.stage) : undefined,
          orderBy: "publishedDate",
          order: "DESC",
          size: params.size as number,
          page: params.page as number,
        });
        const { data } = await fetchWithRetryNote<CfSearch>(ctx, url);
        const keyword = params.keyword ? String(params.keyword) : "";
        const rows: ReturnType<typeof releaseRow>[] = [];
        let fetched = 0;
        for (const res of data.results ?? []) {
          for (const r of res.releases ?? []) {
            fetched++;
            if (matchesKeyword(r, keyword)) rows.push(releaseRow(r, res.publishedDate, res.uri));
          }
        }
        return {
          summary: `${data.hitsCount ?? fetched} notices published ${from} to ${to}${params.stage ? ` at stage ${params.stage}` : ""}; ${rows.length} of the ${fetched} on page ${params.page}${data.maxPage ? ` of ${data.maxPage}` : ""} match${keyword ? ` "${keyword}"` : ""}.`,
          columns: COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "contracts-finder/ocds-search", basis: rows.length ? "measured" : "unavailable" }),
          warnings: keyword ? ["Keyword filtering is applied to the fetched page only; check further pages for an exhaustive search."] : undefined,
        };
      },
    },
    {
      id: "fts_releases",
      label: "Find a Tender releases updated in a window",
      description: "OCDS release package from Find a Tender for records updated in a window (up to 7 days), optionally keyword-filtered.",
      params: [
        { name: "updated_from", label: "Updated from", type: "date", required: true, placeholder: "2026-09-01" },
        { name: "updated_to", label: "Updated to", type: "date", required: true, placeholder: "2026-09-07" },
        { name: "keyword", label: "Keyword(s)", type: "string", placeholder: "heat pump" },
        { name: "stage", label: "Stage", type: "select", options: STAGES, default: "" },
      ],
      async run(params, ctx) {
        const from = String(params.updated_from);
        const to = String(params.updated_to);
        assertRange(from, to, 7, "updated window");
        const url = buildUrl(FTS_BASE, "api/1.0/ocdsReleasePackages", {
          updatedFrom: `${from}T00:00:00`,
          updatedTo: `${to}T23:59:59`,
          stages: params.stage ? String(params.stage) : undefined,
          limit: 100,
        });
        const { data } = await fetchWithRetryNote<FtsPackage>(ctx, url);
        const keyword = params.keyword ? String(params.keyword) : "";
        const releases = data.releases ?? [];
        const rows = releases.filter((r) => matchesKeyword(r, keyword)).map((r) => releaseRow(r, r.date, r.ocid ? `${FTS_BASE}/api/1.0/ocdsReleasePackages/${encodeURIComponent(r.ocid)}` : undefined));
        return {
          summary: `${releases.length} Find a Tender releases updated ${from} to ${to}; ${rows.length} match${keyword ? ` "${keyword}"` : ""}.${data.links?.next ? " More pages are available." : ""}`,
          columns: COLUMNS,
          rows,
          raw: { uri: data.uri, publishedDate: data.publishedDate, next: data.links?.next, releaseCount: releases.length, releases: releases.slice(0, 100) },
          provenance: makeProvenance(definition, ctx, { dataset: "find-a-tender/ocdsReleasePackages", basis: rows.length ? "measured" : "unavailable" }),
          links: data.links?.next ? [{ label: "Next page (OCDS)", url: data.links.next }] : undefined,
        };
      },
    },
  ],
});
