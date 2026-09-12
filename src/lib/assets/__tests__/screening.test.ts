import { describe, expect, it } from "vitest";
import { runScreening, SCREENING_PROFILE } from "../screening";
import type { AssetRecord } from "../types";
import { routedFetch, testContext } from "@/lib/integrations/testing";
import { openDatabase } from "@/lib/db/sqlite";
import { AssetsRepository } from "../repo";

const asset: AssetRecord = { id: "a1", name: "Test", postcode: "SW1A1AA", latitude: 51.5, longitude: -0.14, createdAt: "t", updatedAt: "t" };

describe("runScreening", () => {
  it("records ok, empty, error, skipped and not-configured outcomes without aborting", async () => {
    const fetch = routedFetch([
      { match: "api.postcodes.io", body: { status: 200, result: { postcode: "SW1A 1AA", latitude: 51.5, longitude: -0.14, country: "England", admin_district: "Westminster", codes: {} } } },
      { match: "flood-monitoring/id/floods", body: { items: [] } },
      { match: /.*/, status: 503, body: "down" },
    ]);
    const run = await runScreening(asset, testContext(fetch, {}), SCREENING_PROFILE);
    const by = Object.fromEntries(run.results.map((r) => [`${r.sourceId}/${r.opId}`, r.status]));
    expect(by["postcodes-io/lookup"]).toBe("ok");
    expect(by["ea-flood-monitoring/warnings"]).toBe("empty");
    expect(by["epc-england-wales/non-domestic-search"]).toBe("not_configured");
    expect(by["ea-long-term-flood-risk/risk-at-point"]).toBe("error");
    expect(run.results.find((r) => r.sourceId === "ea-long-term-flood-risk")?.error).toMatch(/503|HTTP/);
    // Natural England turns per-layer failures into warnings with no rows: partial, not empty.
    expect(by["natural-england/designations_near"]).toBe("partial");
    expect(run.okCount).toBeGreaterThanOrEqual(2);
    expect(run.errorCount).toBeGreaterThanOrEqual(1);
  });

  it("skips location checks when the asset has no coordinates", async () => {
    const run = await runScreening({ ...asset, latitude: undefined, longitude: undefined, postcode: undefined }, testContext(routedFetch([])), SCREENING_PROFILE);
    expect(run.results.every((r) => r.status === "skipped")).toBe(true);
  });

  it("persists and reloads the latest screening", async () => {
    const db = openDatabase(":memory:");
    const repo = new AssetsRepository(db);
    const a = repo.create({ name: "x" });
    const run = await runScreening({ ...a, latitude: 51.5, longitude: -0.1 }, testContext(routedFetch([{ match: /.*/, status: 500, body: "x" }])));
    repo.saveScreening(run);
    expect(repo.latestScreening(a.id)?.results.length).toBe(run.results.length);
    expect(repo.listScreenings(a.id)).toHaveLength(1);
  });
});
