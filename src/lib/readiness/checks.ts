import type { Db } from "@/lib/db/sqlite";
import type { OperationContext } from "@/lib/integrations/framework";
import { checkConfigured } from "@/lib/integrations/framework";
import { getIntegration } from "@/lib/integrations/registry";
import { listIntegrations } from "@/lib/integrations/service";
import { listReferenceFiles } from "@/lib/integrations/_shared/reference-data";
import { DESNZ_SELECTORS, desnzFactor, residualMixFactor } from "@/lib/carbon/factors";
import type { Period } from "@/lib/carbon/period";
import { portfolioReport, type PortfolioReport } from "@/lib/carbon/portfolio";
import { ReadingsRepository } from "@/lib/db/readings-repo";
import { SqliteConsentStore } from "@/lib/consent/sqlite-store";
import type { ConsentStore } from "@/lib/consent/store";
import { toView, type ConsentRecord, type ConsentView } from "@/lib/consent/types";
import { transportCarbon, type TransportCarbon } from "@/lib/transport/carbon";
import { TRANSPORT_CATEGORIES } from "@/lib/transport/types";

/**
 * Reporting readiness: what is still missing before a client's return can be
 * filed for a period.
 *
 * Every figure here comes from the modules that already own it — the portfolio
 * roll-up, the transport engine, the factor loaders, the consent store and the
 * integration registry — so readiness can never disagree with the numbers the
 * rest of the portal reports. Nothing is invented: a check that cannot run is
 * "unknown" with the reason rather than "ok", and a check that finds nothing
 * wrong says what it verified.
 *
 * Severity is about consequence, not effort:
 *  - blocker  a figure would be wrong, or unlawful, to file;
 *  - gap      a figure is incomplete and must be disclosed as such;
 *  - advisory it limits analysis but not the return.
 */

export type Severity = "blocker" | "gap" | "advisory";

export interface ReadinessCheck {
  id: string;
  group: string;
  title: string;
  severity: Severity;
  status: "ok" | "attention" | "unknown";
  /** Plain English, naming the specific thing and the number. */
  detail: string;
  /** Where in the portal it is fixed. */
  fix?: { label: string; href: string };
  count?: number;
}

export interface ReadinessReport {
  period: Period;
  checks: ReadinessCheck[];
  score: { ok: number; attention: number; total: number; blockers: number };
  /** One or two sentences a consultant could paste into an email. */
  summary: string;
}

export interface ReadinessOptions {
  /** Consent store to read from. Defaults to the database passed in. */
  consentStore?: ConsentStore;
  /** Consents already loaded, for callers that hold them (and for tests). */
  consents?: ConsentRecord[];
}

export const READINESS_GROUPS = ["Reference data", "Assets", "Consents", "Scope coverage", "Integrations"] as const;
export type ReadinessGroup = (typeof READINESS_GROUPS)[number];

const FIX = {
  sources: { label: "Data sources", href: "/sources" },
  assets: { label: "Assets", href: "/assets" },
  consents: { label: "Consents", href: "/consents" },
  transport: { label: "Transport", href: "/transport" },
  portfolio: { label: "Portfolio", href: "/portfolio" },
} as const;

const MS_PER_DAY = 86_400_000;
/** Consents falling due this close to the period end are reported as expiring. */
export const EXPIRY_WINDOW_DAYS = 60;
/** Below this, a period is treated as incompletely covered by readings. */
export const COMPLETENESS_TARGET = 95;

const fmt = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 0 });

/** "A, B and 2 more" — never a bare count where the specific thing can be named. */
function nameList(names: string[], max = 4): string {
  if (names.length <= max) return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ------------------------------------------------------------------ */
/* the emissions module, which may not exist yet                       */
/* ------------------------------------------------------------------ */

/**
 * The emissions module (refrigerants, water and waste) is optional: it covers
 * the categories meter data cannot reach, and it may not be installed. It is
 * therefore loaded through a specifier held in a variable, inside a try/catch,
 * so this file compiles and runs either way — and any check that depends on it
 * reports "unknown" with the reason rather than "ok" when it cannot be read.
 *
 * Two shapes are understood: `emissionsCarbon(db, ctx, period)` as the module
 * exports today, and a plain `emissionsCoverage` / `recordedCategories`
 * function for a module that only wants to declare what it holds.
 */
export interface EmissionsCoverageEntry {
  /** Category key, e.g. "refrigerant", "waste". */
  key: string;
  label?: string;
  /** Records held for the period. Zero means the category is genuinely empty. */
  lines: number;
  kgCo2e?: number | null;
}

export type EmissionsProbe = { available: true; coverage: EmissionsCoverageEntry[] } | { available: false; reason: string };

const EMISSIONS_MODULE = "@/lib/emissions";
const FAMILIES = ["refrigerant", "water", "waste"] as const;

type Loader = () => Promise<unknown>;
const defaultLoader: Loader = () => import(/* @vite-ignore */ EMISSIONS_MODULE);
let loadEmissionsModule: Loader = defaultLoader;

/** Test hook: replace the module loader, or pass undefined to restore it. */
export function setEmissionsLoader(loader?: Loader): void {
  loadEmissionsModule = loader ?? defaultLoader;
}

export async function probeEmissions(db: Db, ctx: OperationContext, period: Period): Promise<EmissionsProbe> {
  let mod: Record<string, unknown>;
  try {
    mod = ((await loadEmissionsModule()) ?? {}) as Record<string, unknown>;
  } catch (e) {
    return { available: false, reason: `The emissions module (${EMISSIONS_MODULE}) is not installed, so the portal cannot say whether anything is recorded here (${message(e)}).` };
  }
  try {
    if (typeof mod.emissionsCarbon === "function") {
      const result = (mod.emissionsCarbon as (d: Db, c: OperationContext, p: Period) => unknown)(db, ctx, period) as { lines?: { family?: string; kgCo2e?: number | null }[] };
      const lines = Array.isArray(result?.lines) ? result.lines : [];
      return {
        available: true,
        coverage: FAMILIES.map((family) => {
          const own = lines.filter((l) => l.family === family);
          return { key: family, label: family, lines: own.length, kgCo2e: own.some((l) => l.kgCo2e === null || l.kgCo2e === undefined) ? null : own.reduce((n, l) => n + (l.kgCo2e ?? 0), 0) };
        }),
      };
    }
    const declare = ["emissionsCoverage", "recordedCategories"].map((k) => mod[k]).find((v) => typeof v === "function") as
      | ((d: Db, c: OperationContext, p: Period) => EmissionsCoverageEntry[] | Promise<EmissionsCoverageEntry[]>)
      | undefined;
    if (!declare) return { available: false, reason: "The emissions module is installed but exports no emissionsCarbon, emissionsCoverage or recordedCategories, so its coverage cannot be read." };
    const coverage = await declare(db, ctx, period);
    return Array.isArray(coverage) ? { available: true, coverage } : { available: false, reason: "The emissions module returned no coverage list." };
  } catch (e) {
    return { available: false, reason: `The emissions module failed while reporting coverage: ${message(e)}.` };
  }
}

function coverageCheck(
  probe: EmissionsProbe,
  id: string,
  title: string,
  match: RegExp,
  absent: string,
  fills: string,
): ReadinessCheck {
  const base = { id, group: "Scope coverage", title, severity: "gap" as const };
  if (!probe.available) return { ...base, status: "unknown", detail: `${probe.reason} ${absent} ${fills}` };
  const entries = probe.coverage.filter((c) => match.test(c.key) || (c.label ? match.test(c.label) : false));
  if (entries.length === 0) return { ...base, status: "unknown", detail: `The emissions module reports no category matching ${match.source}, so nothing can be said about it. ${fills}`, count: 0 };
  const lines = entries.reduce((n, c) => n + (c.lines ?? 0), 0);
  return lines > 0
    ? { ...base, status: "ok", detail: `${fmt(lines)} record${lines === 1 ? "" : "s"} are held under ${entries.map((e) => e.label ?? e.key).join(", ")}.`, count: lines }
    : { ...base, status: "attention", detail: `${absent} ${fills}`, count: 0 };
}

/* ------------------------------------------------------------------ */
/* reference data                                                      */
/* ------------------------------------------------------------------ */

function referenceChecks(ctx: OperationContext, period: Period): ReadinessCheck[] {
  const wanted: { label: string; spec: (typeof DESNZ_SELECTORS)[keyof typeof DESNZ_SELECTORS] }[] = [
    { label: "UK electricity generated", spec: DESNZ_SELECTORS.electricityGenerated },
    { label: "electricity transmission and distribution", spec: DESNZ_SELECTORS.electricityTandD },
    { label: "natural gas (gross CV)", spec: DESNZ_SELECTORS.naturalGasGross },
  ];
  const resolved = wanted.map((w) => ({ ...w, factor: desnzFactor(ctx, period.factorYear, w.spec, w.label) }));
  const missing = resolved.filter((r) => r.factor.value === null);
  const desnz: ReadinessCheck = {
    id: "reference.desnz_factors",
    group: "Reference data",
    title: `DESNZ ${period.factorYear} conversion factors`,
    severity: "blocker",
    status: missing.length === 0 ? "ok" : "attention",
    count: missing.length,
    detail:
      missing.length === 0
        ? `The DESNZ ${period.factorYear} flat file is loaded and all three factors the portal converts with resolve (${resolved[0].factor.reference}).`
        : `${missing.length} of ${resolved.length} DESNZ ${period.factorYear} factors are unavailable, so nothing converts to kgCO2e and every carbon figure in this return is blank. Load data/reference/desnz-conversion-factors/${period.factorYear}.csv. ${missing.map((m) => `${m.label}: ${m.factor.detail ?? "no matching row"}`).join(" ")}`,
    fix: FIX.sources,
  };

  const residual = residualMixFactor(ctx, period.factorYear);
  const aib: ReadinessCheck = {
    id: "reference.aib_residual_mix",
    group: "Reference data",
    title: "AIB residual mix",
    severity: "gap",
    status: residual.value === null ? "attention" : "ok",
    detail:
      residual.value === null
        ? `${residual.detail ?? "No AIB residual mix is available."} Market-based Scope 2 falls back to nothing for every meter without a supplier-specific factor and its evidence, so that total is blank rather than complete.`
        : `The residual mix resolves at ${residual.value} ${residual.unit} (${residual.reference}), so market-based Scope 2 has a fallback for meters with no supplier factor.`,
    fix: FIX.sources,
  };

  const refFile = (id: string, title: string, checkId: string, purpose: string): ReadinessCheck => {
    const files = listReferenceFiles(ctx.env, id, /\.csv$/i);
    return {
      id: checkId,
      group: "Reference data",
      title,
      severity: "advisory",
      status: files.length > 0 ? "ok" : "attention",
      count: files.length,
      detail:
        files.length > 0
          ? `${files.length} file${files.length === 1 ? "" : "s"} loaded (${files.map((f) => f.name).join(", ")}), so ${purpose} can run.`
          : `No file is loaded in data/reference/${id}/, so ${purpose} cannot run. This limits analysis; it does not affect the figures in the return.`,
      fix: FIX.sources,
    };
  };

  return [
    desnz,
    aib,
    refFile("crrem-pathways", "CRREM pathways", "reference.crrem_pathways", "the CRREM stranding check on an asset"),
    refFile("uk-nzcbs", "UK NZCBS limits", "reference.uk_nzcbs", "the UK NZCBS check on an asset"),
  ];
}

/* ------------------------------------------------------------------ */
/* assets                                                              */
/* ------------------------------------------------------------------ */

function assetChecks(portfolio: PortfolioReport | null, portfolioError: string | null, period: Period): ReadinessCheck[] {
  const ids = [
    { id: "assets.floor_area", title: "Floor areas", severity: "gap" as const },
    { id: "assets.coordinates", title: "Coordinates", severity: "advisory" as const },
    { id: "assets.meters", title: "Meters linked", severity: "gap" as const },
    { id: "assets.allocation", title: "Shared meter allocation", severity: "blocker" as const },
    { id: "assets.completeness", title: "Data completeness", severity: "gap" as const },
  ];
  if (!portfolio) {
    return ids.map((i) => ({ ...i, group: "Assets", status: "unknown" as const, detail: `The portfolio roll-up could not be produced, so this cannot be checked: ${portfolioError ?? "unknown error"}`, fix: FIX.assets }));
  }
  if (portfolio.assets.length === 0) {
    return ids.map((i) => ({ ...i, group: "Assets", status: "unknown" as const, detail: "No assets have been added, so there is nothing to check. Add the buildings in the reporting boundary first.", count: 0, fix: FIX.assets }));
  }

  const total = portfolio.assets.length;
  const named = (kind: string) => portfolio.issues.filter((i) => i.kind === kind).map((i) => i.assetName ?? i.assetId ?? "unnamed asset");

  const byKind = (id: string, title: string, severity: Severity, kind: string, wrong: (names: string[]) => string, right: string): ReadinessCheck => {
    const names = named(kind);
    return {
      id,
      group: "Assets",
      title,
      severity,
      status: names.length === 0 ? "ok" : "attention",
      count: names.length,
      detail: names.length === 0 ? right : wrong(names),
      fix: FIX.assets,
    };
  };

  const allocation = portfolio.issues.filter((i) => i.kind === "over_allocated" || i.kind === "under_allocated");
  const over = allocation.filter((i) => i.kind === "over_allocated");

  const shortfall = portfolio.assets
    .filter((a) => a.meterCount > 0 && (a.completeness ?? 0) < COMPLETENESS_TARGET)
    .map((a) => ({ name: a.name, pct: a.completeness ?? 0 }))
    .sort((a, b) => a.pct - b.pct);

  return [
    byKind(
      "assets.floor_area",
      "Floor areas",
      "gap",
      "no_floor_area",
      (n) => `${n.length} of ${total} assets have no floor area, so they have no EUI and no kgCO2e/m² intensity: ${nameList(n)}. Any intensity disclosed covers only the assets that have one.`,
      `All ${total} assets have a floor area, so EUI and intensity are reported for the whole portfolio.`,
    ),
    byKind(
      "assets.coordinates",
      "Coordinates",
      "advisory",
      "no_location",
      (n) => `${n.length} of ${total} assets have no coordinates, so environmental screening (flood, ground, designations) cannot run for them: ${nameList(n)}. Screening informs risk work, not the return.`,
      `All ${total} assets have coordinates, so environmental screening can run for every one.`,
    ),
    byKind(
      "assets.meters",
      "Meters linked",
      "gap",
      "no_meters",
      (n) => `${n.length} of ${total} assets have no meter linked, so they contribute no energy and no carbon and the totals cover only part of the portfolio: ${nameList(n)}.`,
      `All ${total} assets have at least one meter linked.`,
    ),
    {
      id: "assets.allocation",
      group: "Assets",
      title: "Shared meter allocation",
      severity: "blocker",
      status: allocation.length === 0 ? "ok" : "attention",
      count: allocation.length,
      detail:
        allocation.length === 0
          ? `Every shared meter's allocation shares add up to 100%, so no energy is double counted or left unattributed.`
          : `${allocation.length} asset-to-meter link${allocation.length === 1 ? " is" : "s are"} allocated wrongly${over.length > 0 ? `, ${over.length} of them over-allocated so energy and carbon are double counted` : ", all under-allocated so some energy belongs to no asset"}. ${allocation.map((i) => `${i.assetName ?? i.assetId}: ${i.detail}`).join(" ")}`,
      fix: FIX.assets,
    },
    {
      id: "assets.completeness",
      group: "Assets",
      title: "Data completeness",
      severity: "gap",
      status: shortfall.length === 0 ? "ok" : "attention",
      count: shortfall.length,
      detail:
        shortfall.length === 0
          ? `Every metered asset has readings covering at least ${COMPLETENESS_TARGET}% of the elapsed days in ${period.label}.`
          : `${shortfall.length} metered asset${shortfall.length === 1 ? "" : "s"} have readings for less than ${COMPLETENESS_TARGET}% of ${period.label}; the worst are ${nameList(shortfall.map((s) => `${s.name} (${s.pct}%)`), 3)}. Energy and carbon for those assets are understated and must be disclosed as partial.`,
      fix: FIX.assets,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* consents                                                            */
/* ------------------------------------------------------------------ */

function consentChecks(db: Db, period: Period, views: ConsentView[] | null, consentError: string | null): ReadinessCheck[] {
  const periodEndMs = Date.parse(period.to) - 1;
  const periodEnd = new Date(periodEndMs).toISOString().slice(0, 10);
  if (!views) {
    return [
      { id: "consents.readings_without_consent", group: "Consents", title: "Consent for stored readings", severity: "blocker", status: "unknown", detail: `The consent store could not be read, so the legal basis for the stored readings cannot be confirmed: ${consentError ?? "unknown error"}`, fix: FIX.consents },
      { id: "consents.expiring", group: "Consents", title: "Consents expiring", severity: "gap", status: "unknown", detail: `The consent store could not be read, so upcoming expiries cannot be listed: ${consentError ?? "unknown error"}`, fix: FIX.consents },
    ];
  }

  let uncovered: string[] = [];
  let metersInPeriod = 0;
  let readingsError: string | null = null;
  try {
    const meters = new ReadingsRepository(db).listMeters().filter((m) => m.last >= period.from && m.first < period.to);
    metersInPeriod = meters.length;
    uncovered = meters
      .filter((m) => !views.some((c) => c.mpxn === m.mpxn && c.effectiveStatus === "active" && (m.utility === "electricity" || m.utility === "gas" ? c.utilities.includes(m.utility) : true)))
      .map((m) => `${m.mpxn} (${m.utility}, ${fmt(m.count)} readings)`);
  } catch (e) {
    readingsError = message(e);
  }

  const held: ReadinessCheck = readingsError
    ? { id: "consents.readings_without_consent", group: "Consents", title: "Consent for stored readings", severity: "blocker", status: "unknown", detail: `The stored readings could not be listed, so their legal basis cannot be confirmed: ${readingsError}`, fix: FIX.consents }
    : {
        id: "consents.readings_without_consent",
        group: "Consents",
        title: "Consent for stored readings",
        severity: "blocker",
        status: uncovered.length === 0 ? "ok" : "attention",
        count: uncovered.length,
        detail:
          uncovered.length === 0
            ? metersInPeriod === 0
              ? `No meter has readings inside ${period.label}, so no consent is relied on for this period.`
              : `All ${metersInPeriod} meters with readings in ${period.label} are covered by an active consent.`
            : `${uncovered.length} of ${metersInPeriod} meter${metersInPeriod === 1 ? "" : "s"} ${uncovered.length === 1 ? "has" : "have"} readings in ${period.label} with no active consent, so the data is held without a live basis. Record or renew the consent, or remove the readings, before anything derived from them is filed: ${nameList(uncovered)}.`,
        fix: FIX.consents,
      };

  const windowEnd = new Date(periodEndMs + EXPIRY_WINDOW_DAYS * MS_PER_DAY).toISOString().slice(0, 10);
  const live = views.filter((c) => c.status !== "withdrawn");
  const expiring = live.filter((c) => c.expiresOn <= windowEnd).sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
  const soonest = [...live].sort((a, b) => a.expiresOn.localeCompare(b.expiresOn))[0];
  const expiries: ReadinessCheck = {
    id: "consents.expiring",
    group: "Consents",
    title: `Consents expiring within ${EXPIRY_WINDOW_DAYS} days of the period end`,
    severity: "gap",
    status: expiring.length === 0 ? "ok" : "attention",
    count: expiring.length,
    detail:
      expiring.length === 0
        ? live.length === 0
          ? "No live consents are recorded, so none is due to expire."
          : `None of the ${live.length} live consents expires on or before ${windowEnd}${soonest ? `; the earliest is ${soonest.mpxn} on ${soonest.expiresOn}` : ""}.`
        : `${expiring.length} consent${expiring.length === 1 ? "" : "s"} expire on or before ${windowEnd} (${EXPIRY_WINDOW_DAYS} days after the period end ${periodEnd}): ${nameList(expiring.map((c) => `${c.mpxn} on ${c.expiresOn}${c.effectiveStatus === "expired" ? ", already expired" : ""}`))}. Retrieval stops when they lapse, so the next period's data will be incomplete.`,
    fix: FIX.consents,
  };
  return [held, expiries];
}

/* ------------------------------------------------------------------ */
/* scope coverage — kept in step with SECR_EXCLUSIONS                  */
/* ------------------------------------------------------------------ */

function scopeChecks(portfolio: PortfolioReport | null, portfolioError: string | null, transport: TransportCarbon | null, transportError: string | null, emissions: EmissionsProbe, period: Period): ReadinessCheck[] {
  const base = (id: string, title: string): Pick<ReadinessCheck, "id" | "group" | "title" | "severity"> => ({ id, group: "Scope coverage", title, severity: "gap" });

  const fromPortfolio = (id: string, title: string, has: (p: PortfolioReport) => boolean, right: (p: PortfolioReport) => string, wrong: string): ReadinessCheck => {
    if (!portfolio) return { ...base(id, title), status: "unknown", detail: `The portfolio roll-up could not be produced, so this cannot be checked: ${portfolioError ?? "unknown error"}`, fix: FIX.assets };
    return has(portfolio)
      ? { ...base(id, title), status: "ok", detail: right(portfolio), fix: FIX.assets }
      : { ...base(id, title), status: "attention", detail: wrong, fix: FIX.assets };
  };

  const transportLines = (predicate: (category: keyof typeof TRANSPORT_CATEGORIES) => boolean) =>
    transport ? transport.lines.filter((l) => predicate(l.category)) : [];

  const fromTransport = (id: string, title: string, predicate: (category: keyof typeof TRANSPORT_CATEGORIES) => boolean, right: (n: number, kg: number | null) => string, wrong: string): ReadinessCheck => {
    if (!transport) return { ...base(id, title), status: "unknown", detail: `Transport and travel could not be read, so this cannot be checked: ${transportError ?? "unknown error"}`, fix: FIX.transport };
    const lines = transportLines(predicate);
    const unresolved = lines.filter((l) => l.kgCo2e === null).length;
    const kg = unresolved > 0 ? null : lines.reduce((n, l) => n + (l.kgCo2e ?? 0), 0);
    return lines.length > 0
      ? { ...base(id, title), status: "ok", detail: right(lines.length, kg), count: lines.length, fix: FIX.transport }
      : { ...base(id, title), status: "attention", detail: wrong, count: 0, fix: FIX.transport };
  };

  const kgText = (kg: number | null) => (kg === null ? "a total that is blank because a factor is missing on at least one line" : `${fmt(kg)} kgCO2e`);

  return [
    fromPortfolio(
      "scope.s1_stationary",
      "Scope 1 stationary combustion",
      (p) => p.totals.gasKwh > 0,
      (p) => `${fmt(p.totals.gasKwh)} kWh of gas is recorded across ${p.totals.assets} assets. Non-metered fuels (oil, LPG and biomass) are still not captured; only electricity and gas meter data is held.`,
      `No stationary fuel is recorded for ${period.label}. Gas meter readings fill this; oil, LPG and biomass are not captured by the portal at all and stay a stated exclusion.`,
    ),
    fromTransport(
      "scope.s1_mobile",
      "Scope 1 mobile combustion",
      (c) => TRANSPORT_CATEGORIES[c].scope === 1,
      (n, kg) => `${n} own or leased vehicle line${n === 1 ? "" : "s"} recorded, giving ${kgText(kg)}.`,
      "No transport activity has been recorded for this period. SECR requires transport energy for UK operations; add own and leased vehicle fuel or mileage on the Transport page before disclosing.",
    ),
    coverageCheck(
      emissions,
      "scope.s1_fugitive",
      "Scope 1 fugitive emissions",
      /fugitive|refrigerant/i,
      "Fugitive emissions (refrigerants) are not captured by the portal; these are Scope 1 and are usually material for air-conditioned buildings.",
      "Refrigerant top-up and F-gas service records for each chiller, VRF and split system, by gas type and kg, would fill this.",
    ),
    fromPortfolio(
      "scope.s2_electricity",
      "Scope 2 purchased electricity",
      (p) => p.totals.electricityKwh > 0,
      (p) => `${fmt(p.totals.electricityKwh)} kWh of imported electricity is recorded, reported both location-based and market-based.`,
      `No imported electricity is recorded for ${period.label}, so there is no Scope 2 at all. Link the electricity meters to their assets and sync readings.`,
    ),
    (() => {
      const wtt = transportLines((c) => TRANSPORT_CATEGORIES[c].ghgCategory.startsWith("Category 3"));
      const tandd = portfolio ? portfolio.totals.electricityKwh > 0 : false;
      if (!portfolio) return { ...base("scope.s3_c3", "Scope 3 category 3 (fuel and energy related)"), status: "unknown" as const, detail: `The portfolio roll-up could not be produced, so transmission and distribution losses cannot be checked: ${portfolioError ?? "unknown error"}`, fix: FIX.assets };
      return tandd || wtt.length > 0
        ? { ...base("scope.s3_c3", "Scope 3 category 3 (fuel and energy related)"), status: "ok" as const, detail: `Transmission and distribution losses are calculated on ${fmt(portfolio.totals.electricityKwh)} kWh of imported electricity${wtt.length > 0 ? `, alongside ${wtt.length} well-to-tank line${wtt.length === 1 ? "" : "s"}` : ", though no well-to-tank lines for transport fuel are recorded"}.`, fix: FIX.assets }
        : { ...base("scope.s3_c3", "Scope 3 category 3 (fuel and energy related)"), status: "attention" as const, detail: "Category 3 covers transmission and distribution losses on purchased electricity and well-to-tank for fuel. Neither is present: there is no imported electricity to apply the T&D factor to, and no well-to-tank lines are recorded.", fix: FIX.assets };
    })(),
    coverageCheck(
      emissions,
      "scope.s3_c5_waste",
      "Scope 3 category 5 (waste)",
      /waste/i,
      "Waste is one of the other Scope 3 categories the portal does not capture: only category 3 (transmission and distribution losses) is calculated from meter data.",
      "Waste transfer notes giving tonnage by disposal route (recycling, energy from waste, landfill) would fill this.",
    ),
    fromTransport(
      "scope.s3_c6_travel",
      "Scope 3 category 6 (business travel)",
      (c) => TRANSPORT_CATEGORIES[c].ghgCategory.startsWith("Category 6"),
      (n, kg) => `${n} business travel line${n === 1 ? "" : "s"} recorded, giving ${kgText(kg)}.`,
      "No business travel has been recorded for this period. Air, rail, taxi and hire car journeys, hotel nights and grey-fleet business mileage all belong here.",
    ),
    fromTransport(
      "scope.s3_c7_commuting",
      "Scope 3 category 7 (employee commuting)",
      (c) => TRANSPORT_CATEGORIES[c].ghgCategory.startsWith("Category 7"),
      (n, kg) => `${n} commuting line${n === 1 ? "" : "s"} recorded, giving ${kgText(kg)}.`,
      "No employee commuting has been recorded for this period. A commuting survey, or headcount by site with mode and distance, would fill it.",
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* integrations                                                        */
/* ------------------------------------------------------------------ */

function integrationChecks(db: Db, ctx: OperationContext): ReadinessCheck[] {
  const all = listIntegrations(ctx.env);
  const configured = all.filter((i) => i.configured);
  const registered: ReadinessCheck = {
    id: "integrations.configured",
    group: "Integrations",
    title: "Configured data sources",
    severity: "advisory",
    status: configured.length === 0 ? "attention" : "ok",
    count: configured.length,
    detail:
      configured.length === 0
        ? `None of the ${all.length} registered data sources is configured, so nothing can be refreshed or verified from source. Stored figures are unaffected.`
        : `${configured.length} of ${all.length} registered data sources are configured. The rest need a key, a contract or a bulk download and are not required for the return.`,
    fix: FIX.sources,
  };

  const depended: { id: string; why: string }[] = [];
  let dependencyError: string | null = null;
  try {
    const rows = db.prepare("SELECT source, COUNT(*) AS n FROM meter_readings GROUP BY source").all() as unknown as { source: string; n: number }[];
    for (const r of rows) depended.push({ id: r.source, why: `${fmt(r.n)} stored meter readings` });
    const intensity = db.prepare("SELECT COUNT(*) AS n FROM grid_intensity").get() as unknown as { n: number };
    if (intensity.n > 0) depended.push({ id: "carbon-intensity", why: `${fmt(intensity.n)} stored half-hourly grid intensity rows` });
  } catch (e) {
    dependencyError = message(e);
  }

  const unconfigured = depended
    .map((d) => ({ ...d, def: getIntegration(d.id) }))
    .filter((d) => d.def)
    .map((d) => ({ ...d, cfg: checkConfigured(d.def!, ctx.env) }))
    .filter((d) => !d.cfg.configured);

  const dependencies: ReadinessCheck = dependencyError
    ? { id: "integrations.depended_on", group: "Integrations", title: "Sources behind the stored figures", severity: "advisory", status: "unknown", detail: `The stored figures' sources could not be listed, so their configuration cannot be checked: ${dependencyError}`, fix: FIX.sources }
    : {
        id: "integrations.depended_on",
        group: "Integrations",
        title: "Sources behind the stored figures",
        severity: "advisory",
        status: unconfigured.length === 0 ? "ok" : "attention",
        count: unconfigured.length,
        detail:
          depended.length === 0
            ? "No stored figure comes from an external source yet, so none needs configuring."
            : unconfigured.length === 0
              ? `Every source behind a stored figure is configured (${nameList(depended.map((d) => `${d.id}: ${d.why}`))}).`
              : `${unconfigured.length} source${unconfigured.length === 1 ? "" : "s"} the stored figures came from ${unconfigured.length === 1 ? "is" : "are"} not configured: ${nameList(unconfigured.map((d) => `${d.id} (${d.why}) needs ${d.cfg.missing.join(", ")}`))}. The figures already held stand; they cannot be refreshed or re-verified until the key is set.`,
        fix: FIX.sources,
      };

  return [registered, dependencies];
}

/* ------------------------------------------------------------------ */
/* assembly                                                            */
/* ------------------------------------------------------------------ */

/** First sentence of a detail, short enough to sit in a summary line. */
function brief(detail: string): string {
  const first = detail.split(/(?<=\.)\s/)[0] ?? detail;
  if (first.length <= 120) return first.replace(/\.$/, "");
  return `${first.slice(0, 117).replace(/\s\S*$/, "")}…`;
}

export function summarise(checks: ReadinessCheck[], period: Period): string {
  const blockers = checks.filter((c) => c.severity === "blocker" && c.status === "attention");
  const gaps = checks.filter((c) => c.severity === "gap" && c.status === "attention").length;
  const advisories = checks.filter((c) => c.severity === "advisory" && c.status === "attention").length;
  const unknown = checks.filter((c) => c.status === "unknown").length;
  const tail = [
    `${gaps} gap${gaps === 1 ? "" : "s"} must be disclosed as incomplete`,
    `${advisories} advisory item${advisories === 1 ? "" : "s"} limit${advisories === 1 ? "s" : ""} analysis only`,
    unknown > 0 ? `${unknown} check${unknown === 1 ? "" : "s"} could not be run` : "",
  ].filter(Boolean);
  const counts = `${tail.slice(0, -1).join(", ")}${tail.length > 1 ? " and " : ""}${tail[tail.length - 1]}.`;
  if (blockers.length > 0) {
    return `${blockers.length} blocker${blockers.length === 1 ? "" : "s"} must be cleared before the ${period.label} return can be filed: ${blockers.map((b) => `${b.title} — ${brief(b.detail)}`).join("; ")}. Alongside ${blockers.length === 1 ? "it" : "them"}, ${counts}`;
  }
  // An unrun blocker-severity check is not the same as a cleared one, so the
  // summary must not lead with "ready to file" while any of them is unknown.
  const unrunBlockers = checks.filter((c) => c.severity === "blocker" && c.status === "unknown");
  if (unrunBlockers.length > 0) {
    return `Readiness for ${period.label} cannot be confirmed: ${unrunBlockers.length} check${unrunBlockers.length === 1 ? "" : "s"} that would block filing could not be run — ${unrunBlockers.map((b) => `${b.title} (${brief(b.detail)})`).join("; ")}. No blockers were found among the checks that did run, and ${counts}`;
  }
  return `No blockers for ${period.label}: the return is ready to file subject to the exclusions the SECR export lists. ${counts.charAt(0).toUpperCase()}${counts.slice(1)}`;
}

/** Every readiness check for a period, with a summary a consultant can send on. */
export async function assessReadiness(db: Db, ctx: OperationContext, period: Period, opts: ReadinessOptions = {}): Promise<ReadinessReport> {
  const now = ctx.now();

  let portfolio: PortfolioReport | null = null;
  let portfolioError: string | null = null;
  try {
    portfolio = portfolioReport(db, ctx, period);
  } catch (e) {
    portfolioError = message(e);
  }

  let transport: TransportCarbon | null = null;
  let transportError: string | null = null;
  try {
    transport = transportCarbon(db, ctx, period);
  } catch (e) {
    transportError = message(e);
  }

  let views: ConsentView[] | null = null;
  let consentError: string | null = null;
  try {
    const consents = opts.consents ?? (await (opts.consentStore ?? new SqliteConsentStore(db)).list());
    views = consents.map((c) => toView(c, now));
  } catch (e) {
    consentError = message(e);
  }

  const emissions = await probeEmissions(db, ctx, period);

  const checks = [
    ...referenceChecks(ctx, period),
    ...assetChecks(portfolio, portfolioError, period),
    ...consentChecks(db, period, views, consentError),
    ...scopeChecks(portfolio, portfolioError, transport, transportError, emissions, period),
    ...integrationChecks(db, ctx),
  ];

  return {
    period,
    checks,
    score: {
      ok: checks.filter((c) => c.status === "ok").length,
      attention: checks.filter((c) => c.status === "attention").length,
      total: checks.length,
      blockers: checks.filter((c) => c.severity === "blocker" && c.status === "attention").length,
    },
    summary: summarise(checks, period),
  };
}
