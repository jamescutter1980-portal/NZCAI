import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "@/lib/db/sqlite";
import { ReadingsRepository } from "@/lib/db/readings-repo";
import { SqliteConsentStore } from "@/lib/consent/sqlite-store";
import { N3rgyClient } from "@/lib/integrations/n3rgy";
import { listSyncRuns, runN3rgySync } from "../n3rgy-sync";

const now = () => new Date("2026-09-10T08:00:00Z");
const config = { apiKey: "k", environment: "live" as const, baseUrl: "https://api.example" };

/** Builds a half-hourly consumption response for the requested range, optionally skipping intervals. */
function fakeFetch(opts: { skip?: (iso: string) => boolean; exportStatus?: number; tariffStatus?: number } = {}) {
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    const start = parse(u.searchParams.get("start")!);
    const end = parse(u.searchParams.get("end")!);
    if (u.pathname.includes("/production/") && opts.exportStatus) return new Response("no", { status: opts.exportStatus });
    if (u.pathname.includes("/tariff/")) {
      if (opts.tariffStatus) return new Response("no", { status: opts.tariffStatus });
      return json({
        resource: u.pathname, responseTimestamp: "x", start: "s", end: "e",
        values: [{ standingCharges: [{ startDate: "2026-04-01", value: 50 }], prices: [{ timestamp: fmt(start + 1_800_000), value: 25 }] }],
      });
    }
    // n3rgy returns half-hour aligned data whatever the query start
    const aligned = Math.ceil(start / 1_800_000) * 1_800_000;
    const values = [];
    for (let t = aligned + 1_800_000; t <= end + 60_000; t += 1_800_000) {
      const iso = new Date(t - 1_800_000).toISOString();
      if (opts.skip?.(iso)) continue;
      values.push({ timestamp: fmt(t), value: 0.5 });
    }
    return json({ resource: u.pathname, responseTimestamp: "x", start: "s", end: "e", granularity: "halfhour", unit: "kWh", values });
  });
}
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const parse = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
const fmt = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

async function setup(fetch: ReturnType<typeof fakeFetch>) {
  const db = openDatabase(":memory:");
  const store = new SqliteConsentStore(db);
  const client = new N3rgyClient({ config, fetch, now });
  return { db, store, client };
}

describe("runN3rgySync", () => {
  it("backfills active consents, skips inactive ones, stores tariffs and logs the run", async () => {
    const fetch = fakeFetch({ exportStatus: 404 });
    const deps = await setup(fetch);
    const active = await deps.store.create({ mpxn: "1000000000001", utilities: ["electricity"], occupierName: "A", method: "other", grantedOn: "2026-09-01", expiresOn: "2026-09-30", status: "active" });
    await deps.store.create({ mpxn: "1000000000002", utilities: ["gas"], occupierName: "B", method: "other", grantedOn: "2026-09-01", expiresOn: "2027-08-31", status: "pending" });

    const run = await runN3rgySync(deps, { trigger: "test", now, backfillDays: 2 });

    expect(run.summary).toMatchObject({ consents: 1, meters: 2, errors: 0 });
    const imp = run.items.find((i) => i.direction === "import")!;
    expect(imp.from).toBe("2026-09-07T23:59:00.000Z");
    expect(imp.to).toBe("2026-09-09T23:59:00.000Z");
    expect(imp.readingsUpserted).toBe(96);
    expect(imp.gaps).toEqual([]);
    expect(imp.tariffRows).toBe(2);
    expect(run.items.find((i) => i.direction === "export")!.warning).toMatch(/No export register/);
    expect(run.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/expires on 2026-09-30 \(21 days\)/), expect.stringMatching(/pending verification/)]));
    expect(new ReadingsRepository(deps.db).countReadings({ mpxn: active.mpxn, utility: "electricity", direction: "import" })).toBe(96);

    const runs = listSyncRuns(deps.db);
    expect(runs).toHaveLength(1);
    expect(runs[0].summary?.readingsUpserted).toBe(96);
    expect(runs[0].items).toHaveLength(2);
  });

  it("is incremental on the second run and reports gaps", async () => {
    const fetch = fakeFetch({ exportStatus: 404, skip: (iso) => iso === "2026-09-09T10:00:00.000Z" });
    const deps = await setup(fetch);
    await deps.store.create({ mpxn: "1000000000001", utilities: ["electricity"], occupierName: "A", method: "other", grantedOn: "2026-09-01", expiresOn: "2027-08-31", status: "active" });

    const first = await runN3rgySync(deps, { trigger: "test", now, backfillDays: 2, includeExport: false, includeTariff: false });
    expect(first.items[0].gaps).toEqual([{ from: "2026-09-09T10:00:00.000Z", to: "2026-09-09T10:30:00.000Z", missingIntervals: 1 }]);
    const calls = fetch.mock.calls.length;

    const second = await runN3rgySync(deps, { trigger: "test", now, includeExport: false, includeTariff: false });
    expect(second.items[0].warning).toBe("Already up to date.");
    expect(fetch.mock.calls.length).toBe(calls);

    const later = () => new Date("2026-09-11T08:00:00Z");
    const third = await runN3rgySync(deps, { trigger: "test", now: later, includeExport: false, includeTariff: false });
    expect(third.items[0].from).toBe("2026-09-10T00:00:00.000Z");
    expect(third.items[0].readingsUpserted).toBe(48);
  });

  it("records an upstream failure as an item error without aborting the run", async () => {
    const fetch = vi.fn(async () => new Response("boom", { status: 500 }));
    const deps = await setup(fetch);
    await deps.store.create({ mpxn: "1000000000001", utilities: ["electricity"], occupierName: "A", method: "other", grantedOn: "2026-09-01", expiresOn: "2027-08-31", status: "active" });
    const run = await runN3rgySync(deps, { trigger: "test", now, includeExport: false, includeTariff: false });
    expect(run.summary.errors).toBe(1);
    expect(run.items[0].error).toMatch(/HTTP 500/);
  });
});
