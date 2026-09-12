import { buildUrl, defineIntegration, fetchJson, makeProvenance, simpleHealth, type OperationContext, type OperationResult } from "../framework";
import { type EaList, lastSegment, num, text, trimItems } from "../ea-flood-monitoring/ea-lda";
import { wgs84ToOsgb36 } from "../ea-public-registers/osgb";

/**
 * Environment Agency bathing water quality linked data (England; Wales is a
 * separate NRW mirror). Reference: https://environment.data.gov.uk/bwq/doc/api-reference-v0.6.html
 * URI templates confirmed from the published Elda/Linked Data API configuration:
 *   /doc/bathing-water.json?district.gssCode=E07000043
 *   /doc/bathing-water/{eubwid}.json
 *   /doc/nearest-bathing-water/easting/{e}/northing/{n}.json
 *   /doc/bathing-water-quality/in-season/bathing-water/{eubwid}/latest.json
 *   /doc/bathing-water-quality/compliance/bathing-water/{eubwid}/latest.json
 * Paging uses _pageSize/_page. Not exercised live from this codebase.
 */

export const BASE = "https://environment.data.gov.uk";

interface LdaResponse<T> {
  format?: string;
  version?: string;
  result?: { "@id"?: string; items?: T[]; primaryTopic?: T; itemsPerPage?: number; startIndex?: number; totalResults?: number; next?: string };
}

export interface BathingWater {
  "@id"?: string;
  name?: unknown;
  eubwidNotation?: string;
  district?: unknown;
  county?: unknown;
  country?: unknown;
  yearDesignated?: unknown;
  yearDedesignated?: unknown;
  sedimentTypesPresent?: unknown;
  waterQualityImpactedByHeavyRain?: unknown;
  samplingPoint?: { name?: unknown; lat?: number; long?: number; easting?: number; northing?: number };
  latestSampleAssessment?: { sampleClassification?: unknown; sampleDateTime?: unknown } | string;
  latestComplianceAssessment?: { complianceClassification?: unknown; sampleYear?: unknown } | string;
  latestRiskPrediction?: { riskLevel?: unknown; expiresAt?: unknown };
  latestProfile?: unknown;
}

export interface SampleAssessment {
  "@id"?: string;
  bathingWater?: unknown;
  sampleDateTime?: unknown;
  sampleClassification?: unknown;
  escherichiaColiCount?: unknown;
  intestinalEnterococciCount?: unknown;
  recordDate?: unknown;
  abnormalWeatherException?: unknown;
}

export interface ComplianceAssessment {
  "@id"?: string;
  bathingWater?: unknown;
  sampleYear?: unknown;
  complianceClassification?: unknown;
  recordDate?: unknown;
}

function items<T>(data: LdaResponse<T> | EaList<T> | null | undefined): T[] {
  if (!data) return [];
  const r = (data as LdaResponse<T>).result;
  if (r) return r.items ?? (r.primaryTopic ? [r.primaryTopic] : []);
  return (data as EaList<T>).items ?? [];
}

const BW_COLUMNS = ["eubwid", "name", "district", "county", "country", "latest_sample_classification", "latest_compliance_classification", "risk_prediction", "impacted_by_heavy_rain", "year_designated", "latitude", "longitude", "profile"];

export function bathingWaterRow(b: BathingWater) {
  const sample = typeof b.latestSampleAssessment === "object" ? b.latestSampleAssessment : undefined;
  const compliance = typeof b.latestComplianceAssessment === "object" ? b.latestComplianceAssessment : undefined;
  return {
    eubwid: b.eubwidNotation ?? lastSegment(b["@id"]),
    name: text(b.name),
    district: text(b.district),
    county: text(b.county),
    country: text(b.country),
    latest_sample_classification: text(sample?.sampleClassification),
    latest_compliance_classification: text(compliance?.complianceClassification),
    risk_prediction: text(b.latestRiskPrediction?.riskLevel),
    impacted_by_heavy_rain: text(b.waterQualityImpactedByHeavyRain),
    year_designated: text(b.yearDesignated),
    latitude: num(b.samplingPoint?.lat),
    longitude: num(b.samplingPoint?.long),
    profile: `${BASE}/bwq/profiles/profile.html?site=${encodeURIComponent(b.eubwidNotation ?? lastSegment(b["@id"]) ?? "")}`,
  };
}

function dateOf(v: unknown): string | null {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return text(o.inXSDDateTime ?? o.inXSDDate ?? o.label ?? o._value ?? o["@id"]);
  }
  return text(v);
}

const LATEST_COLUMNS = ["record", "eubwid", "date", "classification", "e_coli_cfu_per_100ml", "intestinal_enterococci_cfu_per_100ml", "abnormal_weather_exception", "sample_year"];

export function latestRows(eubwid: string, sample: SampleAssessment | undefined, compliance: ComplianceAssessment | undefined) {
  const rows: Record<string, unknown>[] = [];
  if (sample) {
    rows.push({
      record: "latest in-season sample",
      eubwid,
      date: dateOf(sample.sampleDateTime),
      classification: text(sample.sampleClassification),
      e_coli_cfu_per_100ml: num(sample.escherichiaColiCount),
      intestinal_enterococci_cfu_per_100ml: num(sample.intestinalEnterococciCount),
      abnormal_weather_exception: text(sample.abnormalWeatherException),
      sample_year: null,
    });
  }
  if (compliance) {
    rows.push({
      record: "latest annual classification",
      eubwid,
      date: dateOf(compliance.recordDate),
      classification: text(compliance.complianceClassification),
      e_coli_cfu_per_100ml: null,
      intestinal_enterococci_cfu_per_100ml: null,
      abnormal_weather_exception: null,
      sample_year: text(compliance.sampleYear),
    });
  }
  return rows;
}

async function listBathingWaters(ctx: OperationContext, url: string) {
  const { data } = await fetchJson<LdaResponse<BathingWater>>(ctx, url);
  return { data, rows: items(data).map(bathingWaterRow) };
}

export const definition = defineIntegration({
  id: "ea-bathing-waters",
  name: "EA bathing water quality",
  group: "flood_water",
  access: "open",
  territory: "England",
  description: "Designated bathing waters in England with their latest in-season sample results, annual classification (Excellent, Good, Sufficient, Poor) and pollution risk forecasts, from the Environment Agency bathing water linked data.",
  docsUrl: "https://environment.data.gov.uk/bwq/doc/api-reference-v0.6.html",
  termsUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  attribution: "Contains Environment Agency data © Environment Agency and database right. Contains public sector information licensed under the Open Government Licence v3.0.",
  licence: "OGL",
  envVars: [],
  status: "built_unverified",
  notes: [
    "No key. The bathing season runs 15 May to 30 September; out of season the latest sample can be months old. Annual classifications are published each November from four seasons of data.",
    "Nearest-bathing-water lookups take OSGB36 easting/northing; latitude/longitude are converted with a Helmert transform (about 5 m accuracy) before the call.",
    "Wales is published separately at environment.data.gov.uk/wales/bathing-waters (NRW); Scotland by SEPA. Not covered here.",
    "URI templates come from the published Linked Data API configuration for the service; JSON property names for sample and compliance records are matched defensively.",
  ],
  healthCheck: simpleHealth(buildUrl(BASE, "doc/bathing-water.json", { _pageSize: 1 })),
  operations: [
    {
      id: "by-district",
      label: "Bathing waters in a district",
      description: "Designated bathing waters in a local authority district (by ONS GSS code) with their latest classification.",
      params: [{ name: "gssCode", label: "District GSS code", type: "string", required: true, placeholder: "E07000043", help: "ONS local authority district code, e.g. E07000043 (North Devon). postcodes.io returns it as district_code." }],
      async run(params, ctx): Promise<OperationResult> {
        const code = String(params.gssCode).trim().toUpperCase();
        if (!/^[EWSN]\d{8}$/.test(code)) throw new Error("GSS code should be a letter followed by 8 digits, e.g. E07000043");
        const url = buildUrl(BASE, "doc/bathing-water.json", { "district.gssCode": code, _pageSize: 100 });
        const { data, rows } = await listBathingWaters(ctx, url);
        const classes = rows.map((r) => r.latest_compliance_classification).filter(Boolean);
        return {
          summary: rows.length ? `${rows.length} designated bathing waters in district ${code}${classes.length ? ` (latest classifications: ${Array.from(new Set(classes)).join(", ")})` : ""}.` : `No designated bathing waters in district ${code}.`,
          columns: BW_COLUMNS,
          rows,
          raw: data,
          provenance: makeProvenance(definition, ctx, { dataset: "bathing-water", basis: rows.length ? "measured" : "unavailable" }),
        };
      },
    },
    {
      id: "nearest",
      label: "Nearest bathing waters to a point",
      description: "The closest designated bathing waters to a latitude/longitude (converted to OSGB36 for the service), nearest first.",
      params: [
        { name: "latitude", label: "Latitude", type: "latitude", required: true, placeholder: "50.72" },
        { name: "longitude", label: "Longitude", type: "longitude", required: true, placeholder: "-1.87" },
        { name: "count", label: "How many", type: "integer", default: 5, min: 1, max: 20 },
      ],
      async run(params, ctx): Promise<OperationResult> {
        const { easting, northing } = wgs84ToOsgb36(params.latitude as number, params.longitude as number);
        const url = buildUrl(BASE, `doc/nearest-bathing-water/easting/${easting}/northing/${northing}.json`, { _pageSize: params.count as number });
        const { data, rows } = await listBathingWaters(ctx, url);
        return {
          summary: rows.length ? `${rows.length} nearest bathing waters; closest is ${rows[0].name ?? rows[0].eubwid} (${rows[0].latest_compliance_classification ?? "no classification"}).` : "No designated bathing waters returned.",
          columns: BW_COLUMNS,
          rows,
          raw: trimItems(data as EaList<unknown>),
          provenance: makeProvenance(definition, ctx, { dataset: "nearest-bathing-water", basis: rows.length ? "measured" : "unavailable" }),
          warnings: [`Point converted to OSGB36 easting ${easting}, northing ${northing} (Helmert, about 5 m).`],
        };
      },
    },
    {
      id: "latest",
      label: "Latest sample and classification for a bathing water",
      description: "The most recent in-season sample (E. coli and intestinal enterococci counts) and the latest annual classification for one bathing water id.",
      params: [{ name: "eubwid", label: "Bathing water id", type: "string", required: true, placeholder: "ukc2102-03600", help: "EU bathing water id (eubwid), e.g. ukc2102-03600." }],
      async run(params, ctx): Promise<OperationResult> {
        const id = String(params.eubwid).trim().toLowerCase();
        if (!/^uk[a-z0-9]{4,6}-\d{3,6}$/.test(id)) throw new Error("eubwid should look like ukc2102-03600");
        const sampleUrl = buildUrl(BASE, `doc/bathing-water-quality/in-season/bathing-water/${encodeURIComponent(id)}/latest.json`);
        const complianceUrl = buildUrl(BASE, `doc/bathing-water-quality/compliance/bathing-water/${encodeURIComponent(id)}/latest.json`);
        const [s, c] = await Promise.all([
          fetchJson<LdaResponse<SampleAssessment>>(ctx, sampleUrl, {}, { acceptStatuses: [404] }),
          fetchJson<LdaResponse<ComplianceAssessment>>(ctx, complianceUrl, {}, { acceptStatuses: [404] }),
        ]);
        const sample = s.status === 404 ? undefined : items(s.data)[0];
        const compliance = c.status === 404 ? undefined : items(c.data)[0];
        const rows = latestRows(id, sample, compliance);
        const sr = rows.find((r) => r.record === "latest in-season sample");
        const cr = rows.find((r) => r.record === "latest annual classification");
        return {
          summary: rows.length ? `${id}: ${cr ? `classified ${cr.classification ?? "n/a"} (${cr.sample_year ?? "latest season"})` : "no annual classification"}; ${sr ? `latest sample ${sr.date ?? "n/a"} rated ${sr.classification ?? "n/a"}, E. coli ${sr.e_coli_cfu_per_100ml ?? "n/a"}, enterococci ${sr.intestinal_enterococci_cfu_per_100ml ?? "n/a"} cfu/100 ml` : "no in-season sample"}.` : `No sample or classification records for ${id}.`,
          columns: LATEST_COLUMNS,
          rows,
          raw: { sample: s.data, compliance: c.data },
          provenance: makeProvenance(definition, ctx, { dataset: "bathing-water-quality", basis: rows.length ? "measured" : "unavailable" }),
          links: [{ label: "Bathing water profile", url: `${BASE}/bwq/profiles/profile.html?site=${encodeURIComponent(id)}` }],
        };
      },
    },
  ],
});
