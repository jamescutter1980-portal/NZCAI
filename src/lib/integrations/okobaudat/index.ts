import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationContext } from "../framework";
import { EPD_WARNINGS, pickLang, type ProcessListPage } from "../_shared/ilcd";
import { epdDetailResult, listResult } from "../eco-platform-eco-portal";

/**
 * ÖKOBAUDAT: the German federal (BBSR) database of generic and product LCA
 * datasets for construction, served as ILCD JSON by a soda4LCA node, no key.
 *
 *   GET /datastocks?format=json
 *   GET /datastocks/{uuid}/processes?search=true&name=&format=json&lang=en&pageSize=&startIndex=
 *   GET /processes?search=true&...          (root data stock)
 *   GET /processes/{uuid}?format=json&view=extended&lang=en&version=
 *
 * Shapes follow the soda4LCA service API and public ÖKOBAUDAT clients; not
 * exercised live from this environment.
 */

const BASE = "https://oekobaudat.de/OEKOBAU.DAT/resource";

interface DataStock {
  uuid: string;
  shortName?: string;
  name?: unknown;
  description?: unknown;
  root?: boolean;
}

function isUuid(v: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(v);
}

export const definition = defineIntegration({
  id: "okobaudat",
  name: "ÖKOBAUDAT (BBSR)",
  group: "embodied",
  access: "open",
  territory: "Germany (generic datasets used across Europe)",
  description: "Open German federal database of EN 15804 life-cycle datasets for building materials, construction, transport, energy and disposal, including generic (average) datasets usable where no product EPD exists. Search by name within a data stock and read GWP by life-cycle module.",
  docsUrl: "https://www.oekobaudat.de/en/guidance/software-developers.html",
  termsUrl: "https://www.oekobaudat.de/en/service/legal-notice.html",
  attribution: "Datasets from ÖKOBAUDAT, Federal Institute for Research on Building, Urban Affairs and Spatial Development (BBSR); dataset UUID, version and data stock as recorded.",
  licence: "restricted",
  envVars: [],
  status: "built_unverified",
  notes: [
    "No key. Data stocks are versioned releases (e.g. 'OBD_2024_I'); list them first and search within the release you intend to cite so results are reproducible. The root stock is used when no data stock UUID is given.",
    "Names are German by default; lang=en is requested but many datasets only carry German names, so search in German (e.g. 'Beton', 'Stahl') as well.",
    "Generic datasets (subType 'generic dataset') carry safety margins versus product EPDs; note the subType when comparing. Values are as published (basis 'measured'); ND/MNA are not declared, never 0.",
    "The JSON extraction (LCIAResults, anies per module, referenceToUnitGroupDataSet) is shared with the ECO Portal connector and confirmed from open-source parsers of ÖKOBAUDAT JSON, not from a live call here.",
    ...EPD_WARNINGS,
    "Terms: free to use with attribution to ÖKOBAUDAT/BBSR; check the legal notice before redistributing bulk extracts.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "datastocks", { format: "json" })),
  operations: [
    {
      id: "datastocks",
      label: "List data stocks (releases)",
      description: "Available ÖKOBAUDAT releases with their UUIDs, for reproducible searches.",
      params: [],
      async run(_params, ctx: OperationContext) {
        const url = buildUrl(BASE, "datastocks", { format: "json" });
        const { data } = await fetchJson<{ dataStock?: DataStock[] }>(ctx, url);
        const rows = (data.dataStock ?? []).map((d) => ({ uuid: d.uuid, short_name: d.shortName ?? null, name: pickLang(d.name) ?? null, description: pickLang(d.description) ?? null, root: d.root ?? null }));
        return {
          summary: `${rows.length} data stock(s) available: ${rows.map((r) => r.short_name ?? r.uuid).join(", ")}.`,
          columns: ["uuid", "short_name", "name", "description", "root"],
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "datastocks", basis: rows.length ? "measured" : "unavailable" }),
        };
      },
    },
    {
      id: "search",
      label: "Search datasets by name",
      description: "Datasets whose name matches the text, within a data stock (release) or the root stock.",
      params: [
        { name: "name", label: "Name contains", type: "string", required: true, placeholder: "Beton C30/37" },
        { name: "datastock", label: "Data stock UUID", type: "string", placeholder: "cd2bda71-760b-4fcc-8a0b-3877c10000a8", help: "Optional; from the data stocks operation. Blank searches the root stock." },
        { name: "page_size", label: "Results", type: "integer", default: 25, min: 1, max: 100 },
        { name: "start_index", label: "Start index", type: "integer", default: 0, min: 0, max: 100000 },
      ],
      async run(params, ctx) {
        const stock = params.datastock ? String(params.datastock).trim() : "";
        if (stock && !isUuid(stock)) throw new Error("datastock must be a UUID");
        const path = stock ? `datastocks/${stock}/processes` : "processes";
        const url = buildUrl(BASE, path, { search: true, format: "json", lang: "en", name: String(params.name), pageSize: params.page_size as number, startIndex: params.start_index as number });
        const { data } = await fetchJson<ProcessListPage>(ctx, url);
        return listResult(definition, ctx, data, stock ? `datastocks/${stock}/processes` : "processes", String(params.name), stock ? `datastock ${stock}` : undefined);
      },
    },
    {
      id: "detail",
      label: "Dataset detail: GWP by module",
      description: "Full dataset for one UUID: GWP-total (and sub-indicators) per life-cycle module, declared unit, geography and validity.",
      params: [
        { name: "uuid", label: "Dataset UUID", type: "string", required: true, placeholder: "1cd6b257-a4f8-4509-a83b-492cd34c7d98" },
        { name: "version", label: "Dataset version", type: "string", placeholder: "20.23.050", help: "Optional; latest version when blank." },
      ],
      async run(params, ctx) {
        const uuid = String(params.uuid).trim();
        if (!isUuid(uuid)) throw new Error("uuid must be a UUID");
        const url = buildUrl(BASE, `processes/${uuid}`, { format: "json", view: "extended", lang: "en", version: params.version as string | undefined });
        const { data, status } = await fetchJson<unknown>(ctx, url, {}, { acceptStatuses: [404] });
        if (status === 404) {
          return { summary: `Dataset ${uuid} not found in ÖKOBAUDAT.`, rows: [], columns: ["indicator", "module", "value_kgco2e"], provenance: makeProvenance(definition, ctx, { dataset: "processes", basis: "unavailable" }) };
        }
        return epdDetailResult(definition, ctx, data, "processes", url);
      },
    },
  ],
});
