import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/sqlite";
import { ReadingsRepository } from "@/lib/db/readings-repo";
import { effectiveStatus, toView, type ConsentRecord } from "@/lib/consent/types";
import type { ConsentStore } from "@/lib/consent/store";
import { N3rgyApiError, N3rgyClient, normaliseConsumption, normaliseTariff } from "@/lib/integrations/n3rgy";
import { findGaps, summariseGaps, type Gap } from "./gaps";

export interface SyncOptions {
  trigger: "cli" | "api" | "test";
  /** Only sync this MPxN. */
  mpxn?: string;
  /** Include export (production) readings. Default true; 404s are ignored. */
  includeExport?: boolean;
  /** Include tariffs. Default true; failures are warnings, not errors. */
  includeTariff?: boolean;
  /** How far back to fetch when nothing is stored yet. n3rgy holds ~13 months. */
  backfillDays?: number;
  /** Days before expiry to start warning. */
  expiryWarningDays?: number;
  now?: () => Date;
}

export interface SyncItem {
  consentId: string;
  mpxn: string;
  utility: "electricity" | "gas";
  direction: "import" | "export";
  from?: string;
  to?: string;
  readingsUpserted: number;
  tariffRows: number;
  gaps: Gap[];
  warning?: string;
  error?: string;
}

export interface SyncRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  trigger: string;
  environment: string;
  items: SyncItem[];
  warnings: string[];
  summary: { consents: number; meters: number; readingsUpserted: number; errors: number; gaps: number };
}

/**
 * Pulls new readings and tariffs for every active consent, records gaps and
 * expiry warnings, and logs the run. Safe to run repeatedly: readings are
 * upserted and each pull starts from the last stored interval.
 */
export async function runN3rgySync(deps: { db: Db; store: ConsentStore; client: N3rgyClient }, opts: SyncOptions): Promise<SyncRun> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const repo = new ReadingsRepository(deps.db);
  const runId = randomUUID();
  const items: SyncItem[] = [];
  const warnings: string[] = [];
  const expiryWarningDays = opts.expiryWarningDays ?? 30;
  const backfillDays = opts.backfillDays ?? 395;

  deps.db
    .prepare("INSERT INTO sync_runs (id, started_at, trigger, environment) VALUES (?, ?, ?, ?)")
    .run(runId, startedAt, opts.trigger, deps.client.environment);

  const all = await deps.store.list();
  const consents = all.filter((c) => (!opts.mpxn || c.mpxn === opts.mpxn));
  const at = now();
  const active = consents.filter((c) => effectiveStatus(c, at) === "active");

  for (const c of consents) {
    const v = toView(c, at);
    if (v.effectiveStatus === "active" && v.daysToExpiry <= expiryWarningDays) {
      warnings.push(`Consent ${c.id} for ${c.mpxn} expires on ${c.expiresOn} (${v.daysToExpiry} days).`);
    } else if (v.effectiveStatus === "expired") {
      warnings.push(`Consent ${c.id} for ${c.mpxn} expired on ${c.expiresOn}; no data pulled.`);
    } else if (v.effectiveStatus === "pending") {
      warnings.push(`Consent ${c.id} for ${c.mpxn} is pending verification; no data pulled.`);
    }
  }

  // yesterday 23:59 UTC is the latest complete day
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - 60_000);

  for (const consent of active) {
    for (const utility of consent.utilities) {
      const directions: ("import" | "export")[] = opts.includeExport === false || utility === "gas" ? ["import"] : ["import", "export"];
      for (const direction of directions) {
        items.push(await syncMeter({ deps, repo, consent, utility, direction, end, backfillDays, now, includeTariff: opts.includeTariff !== false && direction === "import" }));
      }
    }
  }

  const finishedAt = now().toISOString();
  const summary = {
    consents: active.length,
    meters: items.length,
    readingsUpserted: items.reduce((n, i) => n + i.readingsUpserted, 0),
    errors: items.filter((i) => i.error).length,
    gaps: items.reduce((n, i) => n + i.gaps.length, 0),
  };
  const insertItem = deps.db.prepare(`
    INSERT INTO sync_items (run_id, consent_id, mpxn, utility, direction, from_ts, to_ts, readings_upserted, tariff_rows, gaps, warning, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const i of items) {
    insertItem.run(runId, i.consentId, i.mpxn, i.utility, i.direction, i.from ?? null, i.to ?? null, i.readingsUpserted, i.tariffRows, JSON.stringify(i.gaps), i.warning ?? null, i.error ?? null);
  }
  deps.db
    .prepare("UPDATE sync_runs SET finished_at = ?, summary = ? WHERE id = ?")
    .run(finishedAt, JSON.stringify({ ...summary, warnings }), runId);

  return { id: runId, startedAt, finishedAt, trigger: opts.trigger, environment: deps.client.environment, items, warnings, summary };
}

async function syncMeter(args: {
  deps: { db: Db; store: ConsentStore; client: N3rgyClient };
  repo: ReadingsRepository;
  consent: ConsentRecord;
  utility: "electricity" | "gas";
  direction: "import" | "export";
  end: Date;
  backfillDays: number;
  now: () => Date;
  includeTariff: boolean;
}): Promise<SyncItem> {
  const { deps, repo, consent, utility, direction, end } = args;
  const key = { mpxn: consent.mpxn, utility, direction };
  const item: SyncItem = { consentId: consent.id, mpxn: consent.mpxn, utility, direction, readingsUpserted: 0, tariffRows: 0, gaps: [] };

  const latest = repo.latestIntervalStart(key);
  const start = latest
    ? new Date(new Date(latest).getTime() + 30 * 60_000)
    : new Date(end.getTime() - args.backfillDays * 86_400_000);
  if (start >= end) {
    item.warning = "Already up to date.";
    return item;
  }
  item.from = start.toISOString();
  item.to = end.toISOString();

  try {
    const query = { mpxn: consent.mpxn, utility, start, end, granularity: "halfhour" as const };
    const raw = direction === "export" ? await deps.client.getProduction(query) : await deps.client.getConsumption(query);
    const readings = normaliseConsumption(query, raw, { direction, consentRef: consent.id });
    item.readingsUpserted = repo.upsertReadings(readings);
    if (raw.partial) item.warning = "n3rgy returned partial content for at least one chunk.";

    // Gaps across the whole stored window, not just this pull.
    const stored = repo.listReadings(key, latest ? new Date(new Date(latest).getTime() - 7 * 86_400_000).toISOString() : start.toISOString(), end.toISOString());
    if (stored.length > 0) {
      item.gaps = findGaps(stored.map((r) => r.intervalStart), stored[0].intervalStart, stored[stored.length - 1].intervalStart);
    }
  } catch (e) {
    if (e instanceof N3rgyApiError && e.status === 404 && direction === "export") {
      item.warning = "No export register for this MPxN.";
    } else {
      item.error = e instanceof Error ? e.message : String(e);
      return item;
    }
  }

  if (args.includeTariff) {
    try {
      const raw = await deps.client.getTariff({ mpxn: consent.mpxn, utility, start, end });
      const tariff = normaliseTariff(raw);
      const retrievedAt = tariff.retrievedAt;
      item.tariffRows =
        repo.upsertTariffPrices(tariff.prices.map((p) => ({ mpxn: consent.mpxn, utility, intervalStart: p.intervalStart, pencePerKwh: p.pencePerKwh, retrievedAt }))) +
        repo.upsertStandingCharges(tariff.standingCharges.map((s) => ({ mpxn: consent.mpxn, utility, startDate: s.startDate, pencePerDay: s.pencePerDay, retrievedAt })));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      item.warning = [item.warning, `Tariff not stored: ${msg}`].filter(Boolean).join(" ");
    }
  }
  return item;
}

export function summariseRun(run: SyncRun): string {
  const g = summariseGaps(run.items.flatMap((i) => i.gaps));
  return `${run.summary.consents} active consents, ${run.summary.meters} meters, ${run.summary.readingsUpserted} readings written, ${g.count} gaps (${g.missingIntervals} intervals), ${run.summary.errors} errors, ${run.warnings.length} warnings`;
}

/** Recent sync runs for display. */
export function listSyncRuns(db: Db, limit = 20) {
  const runs = db
    .prepare("SELECT id, started_at, finished_at, trigger, environment, summary FROM sync_runs ORDER BY started_at DESC LIMIT ?")
    .all(limit) as unknown as { id: string; started_at: string; finished_at: string | null; trigger: string; environment: string; summary: string | null }[];
  return runs.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    trigger: r.trigger,
    environment: r.environment,
    summary: r.summary ? (JSON.parse(r.summary) as SyncRun["summary"] & { warnings: string[] }) : null,
    items: (
      db.prepare("SELECT * FROM sync_items WHERE run_id = ? ORDER BY id").all(r.id) as unknown as {
        consent_id: string; mpxn: string; utility: string; direction: string; from_ts: string | null; to_ts: string | null;
        readings_upserted: number; tariff_rows: number; gaps: string | null; warning: string | null; error: string | null;
      }[]
    ).map((i) => ({
      consentId: i.consent_id, mpxn: i.mpxn, utility: i.utility, direction: i.direction, from: i.from_ts, to: i.to_ts,
      readingsUpserted: i.readings_upserted, tariffRows: i.tariff_rows, gaps: i.gaps ? (JSON.parse(i.gaps) as Gap[]) : [],
      warning: i.warning, error: i.error,
    })),
  }));
}
