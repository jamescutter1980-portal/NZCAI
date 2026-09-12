import { round3 } from "@/lib/carbon/factor-line";
import type { CounterpartyView, ValueChainReport } from "./report";
import { spendEstimateFor } from "./report";
import { categoryLabel, type Tier } from "./types";

/**
 * Which counterparties actually matter.
 *
 * Engagement is expensive and a register of two hundred suppliers cannot be
 * worked through evenly. The screen puts a figure against every active
 * counterparty — returned data where it exists, a spend estimate where it does
 * not — ranks them, and marks the point at which the cumulative total passes a
 * chosen share. Everything above that line is where effort belongs.
 *
 * The estimate is for prioritising only. It never feeds the reported total,
 * which is what `valueChainReport` gives; a counterparty screened from spend
 * still counts as having returned nothing.
 */

export type ScreeningBasis = "returned" | "spend_estimate" | "unscreenable";

export interface Hotspot {
  rank: number;
  counterpartyId: string;
  name: string;
  sector?: string;
  annualValueGbp?: number;
  categories: string[];
  state: string;
  basis: ScreeningBasis;
  /** The figure used for ranking. Null only when the counterparty cannot be screened at all. */
  screeningTco2e: number | null;
  tier: Tier | null;
  /** Share of the screened total, and the running total to this rank. */
  sharePct: number | null;
  cumulativeSharePct: number | null;
  /** True while the running total is at or below the concentration threshold. */
  priority: boolean;
  detail: string;
}

export interface Unscreenable {
  counterpartyId: string;
  name: string;
  annualValueGbp?: number;
  reason: string;
}

export interface HotspotScreen {
  reportingYear: number;
  /** The share of screened emissions the priority set is meant to cover. */
  thresholdPct: number;
  hotspots: Hotspot[];
  unscreenable: Unscreenable[];
  totals: {
    screenedTco2e: number;
    returnedTco2e: number;
    estimatedTco2e: number;
    screened: number;
    fromReturnedData: number;
    fromSpendEstimate: number;
    /** Counterparties in the priority set, and what they cover. */
    priorityCount: number;
    prioritySharePct: number | null;
    /** Of the priority set, how many have never returned data. These are the engagement worklist. */
    priorityWithoutData: number;
  };
  detail: string;
  warnings: string[];
}

/**
 * Ranks active counterparties by their best available emissions figure.
 *
 * Unlike the reported total, the screen never returns null for the whole
 * figure: a counterparty that cannot be screened is moved to `unscreenable`
 * with the reason, so one missing sector factor does not blank the ranking
 * that decides where the team spends its week.
 */
export function hotspotScreen(report: ValueChainReport, opts: { thresholdPct?: number } = {}): HotspotScreen {
  const thresholdPct = opts.thresholdPct ?? 80;
  const warnings: string[] = [];
  const active = report.counterparties.filter((v) => v.counterparty.status === "active");

  const screened: { view: CounterpartyView; tco2e: number; basis: Exclude<ScreeningBasis, "unscreenable">; tier: Tier | null; detail: string }[] = [];
  const unscreenable: Unscreenable[] = [];

  for (const v of active) {
    const returned = v.dataSource === "report" || v.dataSource === "ledger";
    if (returned && v.attributableTco2e !== null) {
      screened.push({ view: v, tco2e: v.attributableTco2e, basis: "returned", tier: v.tier, detail: `Returned data at tier ${v.tier ?? "?"}.` });
      continue;
    }
    // No usable returned figure: fall back to spend so the counterparty can still be placed.
    const estimate = v.spendEstimate ?? spendEstimateFor(v.counterparty);
    if (estimate?.attributableTco2e !== undefined && estimate?.attributableTco2e !== null) {
      const note = returned ? "Returned data is held but cannot be turned into a figure yet, so spend is used to place it." : "No data returned; placed from spend.";
      screened.push({ view: v, tco2e: estimate.attributableTco2e, basis: "spend_estimate", tier: "D", detail: `${note} ${estimate.factorKgCo2ePerGbp} kgCO2e per £ from ${estimate.source}.` });
      continue;
    }
    unscreenable.push({
      counterpartyId: v.counterparty.id,
      name: v.counterparty.name,
      annualValueGbp: v.counterparty.annualValueGbp,
      reason:
        v.counterparty.annualValueGbp === undefined && v.counterparty.spendFactorKgCo2ePerGbp === undefined
          ? "No returned data, no annual value and no sector factor, so there is nothing to place it with. Record the annual value and a sector factor."
          : v.counterparty.spendFactorKgCo2ePerGbp === undefined
            ? "No returned data and no sector factor, so spend cannot be converted. Record a factor with its source."
            : "No returned data and no annual value, so the sector factor has nothing to multiply. Record the annual value.",
    });
  }

  screened.sort((a, b) => b.tco2e - a.tco2e || a.view.counterparty.name.localeCompare(b.view.counterparty.name));
  const screenedTotal = screened.reduce((n, s) => n + s.tco2e, 0);
  const returnedTotal = screened.filter((s) => s.basis === "returned").reduce((n, s) => n + s.tco2e, 0);
  const estimatedTotal = screenedTotal - returnedTotal;

  let running = 0;
  const hotspots: Hotspot[] = screened.map((s, i) => {
    const sharePct = screenedTotal > 0 ? round3((s.tco2e / screenedTotal) * 100) : null;
    const wasBelow = screenedTotal > 0 ? (running / screenedTotal) * 100 < thresholdPct : false;
    running += s.tco2e;
    const cumulativeSharePct = screenedTotal > 0 ? round3((running / screenedTotal) * 100) : null;
    return {
      rank: i + 1,
      counterpartyId: s.view.counterparty.id,
      name: s.view.counterparty.name,
      sector: s.view.counterparty.sector,
      annualValueGbp: s.view.counterparty.annualValueGbp,
      categories: s.view.counterparty.ghgCategories.map((c) => categoryLabel(c)),
      state: s.view.state,
      basis: s.basis,
      screeningTco2e: round3(s.tco2e),
      tier: s.tier,
      sharePct,
      cumulativeSharePct,
      priority: wasBelow,
      detail: s.detail,
    };
  });

  const priority = hotspots.filter((h) => h.priority);
  const priorityWithoutData = priority.filter((h) => h.basis !== "returned").length;
  const prioritySharePct = priority.length > 0 ? priority[priority.length - 1].cumulativeSharePct : screenedTotal > 0 ? 0 : null;

  if (screened.length === 0) warnings.push("No active counterparty can be screened: none has returned data and none has both an annual value and a sector factor.");
  if (unscreenable.length > 0) warnings.push(`${unscreenable.length} active counterpart${unscreenable.length === 1 ? "y cannot" : "ies cannot"} be screened at all, so ${unscreenable.length === 1 ? "it is" : "they are"} missing from the ranking rather than ranked low.`);
  if (estimatedTotal > 0 && screenedTotal > 0) {
    const share = round3((estimatedTotal / screenedTotal) * 100);
    if (share > 50) warnings.push(`${share}% of the screened total is spend estimate rather than returned data, so the ranking is indicative. Treat the order as a starting point, not a finding.`);
  }
  if (priorityWithoutData > 0) warnings.push(`${priorityWithoutData} of the ${priority.length} priority counterpart${priority.length === 1 ? "y has" : "ies have"} never returned data. That is the engagement worklist.`);

  const detail =
    screened.length === 0
      ? "Nothing can be screened yet."
      : `${priority.length} of ${screened.length} screened counterpart${screened.length === 1 ? "y accounts" : "ies account"} for ${prioritySharePct ?? 0}% of estimated value chain emissions. ${priorityWithoutData} of them ${priorityWithoutData === 1 ? "has" : "have"} returned nothing.`;

  return {
    reportingYear: report.reportingYear,
    thresholdPct,
    hotspots,
    unscreenable: unscreenable.sort((a, b) => (b.annualValueGbp ?? 0) - (a.annualValueGbp ?? 0)),
    totals: {
      screenedTco2e: round3(screenedTotal),
      returnedTco2e: round3(returnedTotal),
      estimatedTco2e: round3(estimatedTotal),
      screened: screened.length,
      fromReturnedData: screened.filter((s) => s.basis === "returned").length,
      fromSpendEstimate: screened.filter((s) => s.basis === "spend_estimate").length,
      priorityCount: priority.length,
      prioritySharePct,
      priorityWithoutData,
    },
    detail,
    warnings,
  };
}
