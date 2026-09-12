/**
 * CKAN adapter — NGED, which the brief puts first in the build order (§5.2).
 *
 * NGED publishes through CKAN at connecteddata.nationalgrid.co.uk, not
 * Opendatasoft, which is why the registry marks it `api: "ckan"` and why it was
 * the one DNO the original ingest could not touch.
 *
 * THE SHAPE DIFFERENCE THAT MATTERS. Opendatasoft serves records as JSON from
 * the dataset id. CKAN serves a PACKAGE of RESOURCES - a dataset is metadata
 * plus a list of files - so a pull is two steps: read the package, choose a
 * resource, then fetch it. Choosing is the part that can go wrong silently, so
 * the chosen resource is always reported.
 *
 * NOT VERIFIED AGAINST THE LIVE PORTAL. Outbound access was blocked throughout
 * this build. `npm run grid:verify` resolves the package and prints what it
 * finds; until it has been run against the real portal, treat the field
 * mapping as a proposal.
 */

import type {
  AdapterEcrEntry,
  AdapterSubstation,
  DatasetProbe,
  DnoAdapter,
} from "./base";
import { levelFromVoltage, normaliseEcrStatus } from "./base";
import type { DnoEntry } from "../registry";
import { parseCsvLine } from "../csv";

const USER_AGENT = "NZC-AI/0.1 (+grid capacity screening)";

interface CkanResource {
  id?: string;
  name?: string;
  format?: string;
  url?: string;
  last_modified?: string;
  created?: string;
}

interface CkanPackage {
  name?: string;
  title?: string;
  metadata_modified?: string;
  resources?: CkanResource[];
}

async function getJson<T>(url: string, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url: string, timeoutMs = 180_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Picks the resource to download from a CKAN package.
 *
 * Prefers CSV, then the most recently modified. A package can carry PDFs,
 * dashboards and documentation alongside the data, so an unfiltered "first
 * resource" would often fetch a brochure and report zero rows.
 */
export function chooseResource(resources: CkanResource[]): CkanResource | null {
  const usable = resources.filter(
    (r) => typeof r.url === "string" && /^csv$/i.test((r.format ?? "").trim()),
  );
  if (!usable.length) return null;

  return [...usable].sort((a, b) => {
    const when = (r: CkanResource): number =>
      new Date(r.last_modified ?? r.created ?? 0).getTime() || 0;
    return when(b) - when(a);
  })[0];
}

/** Parses a CSV body into records keyed by lower-cased header name. */
export function parseCsvRecords(body: string): Record<string, string>[] {
  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((name, i) => { row[name] = cells[i] ?? ""; });
    return row;
  });
}

function canon(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** First non-empty value among candidate column names. */
export function pick(row: Record<string, string>, candidates: string[]): string | null {
  const index = new Map<string, string>();
  for (const [key, value] of Object.entries(row)) index.set(canon(key), value);
  for (const candidate of candidates) {
    const hit = index.get(canon(candidate));
    if (hit !== undefined && hit !== "") return hit;
  }
  return null;
}

function num(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value.replace(/[, ]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/** kW to MVA is a unit change only; it asserts nothing about power factor. */
function kwToMva(kw: number | null): number | null {
  return kw === null ? null : Math.round((kw / 1000) * 1000) / 1000;
}

export class CkanAdapter implements DnoAdapter {
  constructor(readonly dno: DnoEntry) {}

  private packageUrl(slug: string): string {
    return `https://${this.dno.portalHost}/api/3/action/package_show?id=${encodeURIComponent(slug)}`;
  }

  private async load(kind: "heatmap" | "ecr"): Promise<{
    rows: Record<string, string>[];
    sourceDate: string | null;
    resource: string | null;
  } | null> {
    const ds = this.dno.datasets.find((d) => d.kind === kind);
    if (!ds) return null;

    const payload = await getJson<{ success?: boolean; result?: CkanPackage }>(
      this.packageUrl(ds.slug),
    );
    if (!payload.success || !payload.result) {
      throw new Error(`CKAN package_show returned no result for ${ds.slug}`);
    }

    const resource = chooseResource(payload.result.resources ?? []);
    if (!resource?.url) {
      throw new Error(
        `No CSV resource in CKAN package ${ds.slug} ` +
        `(formats: ${(payload.result.resources ?? []).map((r) => r.format).join(", ") || "none"})`,
      );
    }

    const body = await getText(resource.url);
    return {
      rows: parseCsvRecords(body),
      sourceDate:
        resource.last_modified ?? payload.result.metadata_modified ?? null,
      resource: resource.name ?? resource.url,
    };
  }

  async probe(): Promise<DatasetProbe[]> {
    const probes: DatasetProbe[] = [];

    for (const ds of this.dno.datasets) {
      try {
        const payload = await getJson<{ success?: boolean; result?: CkanPackage }>(
          this.packageUrl(ds.slug),
        );
        const resources = payload.result?.resources ?? [];
        const chosen = chooseResource(resources);

        // Field names need the file itself; the package only lists resources.
        let fields: string[] = [];
        if (chosen?.url) {
          try {
            const head = await getText(chosen.url, 30_000);
            const firstLine = head.split(/\r?\n/)[0] ?? "";
            fields = parseCsvLine(firstLine);
          } catch {
            fields = [];
          }
        }

        probes.push({
          slug: ds.slug,
          kind: ds.kind,
          reachable: Boolean(payload.success),
          fields,
          recordCount: null,
          suggestions: resources.map((r) => `${r.name ?? "?"} [${r.format ?? "?"}]`),
          error: chosen ? null : "package resolved but carries no CSV resource",
        });
      } catch (err) {
        probes.push({
          slug: ds.slug,
          kind: ds.kind,
          reachable: false,
          fields: [],
          recordCount: null,
          suggestions: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return probes;
  }

  async substations(): Promise<AdapterSubstation[] | null> {
    const loaded = await this.load("heatmap");
    if (!loaded) return null;

    return loaded.rows.map((row) => {
      const voltageKv = num(pick(row, ["voltage", "voltagekv", "voltage_kv", "nominalvoltage"]));
      const statedLevel = pick(row, ["level", "substationtype", "assettype", "sitetype"]);

      const level = statedLevel
        ? normaliseLevel(statedLevel)
        : levelFromVoltage(voltageKv);

      const levelSource: AdapterSubstation["levelSource"] =
        statedLevel && level ? "stated" : level ? "derived_from_voltage" : "unknown";

      return {
        sourceRef: pick(row, ["substationid", "siteid", "id", "assetid", "substationnumber"]) ?? "",
        name: pick(row, ["substationname", "sitename", "name"]),
        level,
        levelSource,
        voltageKv,
        lat: num(pick(row, ["latitude", "lat", "y"])),
        lng: num(pick(row, ["longitude", "long", "lng", "x"])),
        demandHeadroomMva: num(pick(row, ["demandheadroommva", "demandheadroom", "availabledemandcapacity"])),
        generationHeadroomMva: num(pick(row, ["generationheadroommva", "generationheadroom", "availablegenerationcapacity"])),
        demandRag: pick(row, ["demandrag", "demandstatus"]),
        generationRag: pick(row, ["generationrag", "generationstatus"]),
        constraintNote: pick(row, ["constraint", "constraintnote", "notes", "comments"]),
        sourceDate: loaded.sourceDate,
        areaGeom: null, // NGED publishes headroom as points, not supply areas.
      };
    }).filter((s) => s.sourceRef);
  }

  async ecr(): Promise<AdapterEcrEntry[] | null> {
    const loaded = await this.load("ecr");
    if (!loaded) return null;

    return loaded.rows.map((row) => {
      // The register publishes capacity in MW or kW depending on the column,
      // so the unit is taken from the column that matched, never assumed.
      const exportMw = num(pick(row, ["exportcapacitymw", "registeredcapacitymw", "maximumexportcapacitymw"]));
      const exportKw = num(pick(row, ["exportcapacitykw", "maximumexportcapacitykw"]));
      const importMw = num(pick(row, ["importcapacitymw", "maximumimportcapacitymw"]));
      const importKw = num(pick(row, ["importcapacitykw", "maximumimportcapacitykw"]));

      return {
        sourceRef: pick(row, ["id", "reference", "connectionid", "projectid"]),
        siteName: pick(row, ["sitename", "customername", "name", "projectname"]),
        technology: pick(row, ["technologytype", "energysource", "primaryenergysource", "technology"]),
        status: normaliseEcrStatus(pick(row, ["connectionstatus", "status", "projectstatus"])),
        exportMva: exportMw ?? kwToMva(exportKw),
        importMva: importMw ?? kwToMva(importKw),
        connectionVoltageKv: num(pick(row, ["connectionvoltagekv", "voltage", "connectionvoltage"])),
        substationName: pick(row, ["substationname", "primarysubstation", "bulksupplypoint"]),
        lat: num(pick(row, ["latitude", "lat", "y"])),
        lng: num(pick(row, ["longitude", "long", "lng", "x"])),
        sourceDate: loaded.sourceDate,
      };
    });
  }
}

/** Maps a source's own level wording onto the brief's four values. */
export function normaliseLevel(raw: string): AdapterSubstation["level"] {
  const text = raw.toLowerCase();
  if (/grid supply|\bgsp\b/.test(text)) return "GSP";
  if (/bulk supply|\bbsp\b/.test(text)) return "BSP";
  if (/primary/.test(text)) return "primary";
  if (/secondary|distribution substation/.test(text)) return "secondary";
  return null;
}
