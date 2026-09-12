// Fixture mirrors the paginated timeseries shape and field list in the UKHSA
// data-dashboard-api source (count/next/previous/results with metric_value and date);
// built from the repository, not from a live call.
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../framework";
import { colourForMatrix, definition, metricUrl } from "..";
import { runOperation, testContext } from "../../testing";
import london from "./fixtures/heat-alert-london.json";

describe("ukhsa-weather-health-alerts", () => {
  it("maps matrix numbers to colours like the dashboard", () => {
    expect(colourForMatrix(1)).toBe("Green");
    expect(colourForMatrix(6)).toBe("Green");
    expect(colourForMatrix(7)).toBe("Yellow");
    expect(colourForMatrix(11)).toBe("Yellow");
    expect(colourForMatrix(12)).toBe("Amber");
    expect(colourForMatrix(15)).toBe("Amber");
    expect(colourForMatrix(16)).toBe("Red");
  });

  it("builds the hierarchical metric URL with encoded segments", () => {
    expect(metricUrl("heat", "Yorkshire and The Humber", 14)).toBe(
      "https://api.ukhsa-dashboard.data.gov.uk/themes/extreme_event/sub_themes/weather_alert/topics/Heat-alert/geography_types/Government%20Office%20Region/geographies/Yorkshire%20and%20The%20Humber/metrics/heat-alert_headline_matrixNumber?page_size=14",
    );
    expect(metricUrl("cold", "London", 5)).toContain("/topics/Cold-alert/");
    expect(metricUrl("cold", "London", 5)).toContain("/metrics/cold-alert_headline_matrixNumber?");
  });

  it("returns the latest alert first with impact and likelihood", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(london), { status: 200 }));
    const result = await runOperation(definition, "current-alert", { alert_type: "heat", region: "London", days: 3 }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe(metricUrl("heat", "London", 3));
    expect(result.rows?.map((r) => r.date)).toEqual(["2026-07-11", "2026-07-10", "2026-07-09"]);
    expect(result.rows?.[1]).toEqual({ date: "2026-07-10", matrix_number: 12, colour: "Amber", impact: "Medium", likelihood: "Medium", region: "London", region_code: "E12000007" });
    expect(result.summary).toMatch(/^YELLOW heat-health alert level for London on 2026-07-11/);
    expect(result.provenance).toMatchObject({ source: "ukhsa-weather-health-alerts", licence: "OGL" });
  });

  it("returns an empty result when no records are published or the path 404s", async () => {
    const empty = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ count: 0, next: null, previous: null, results: [] }), { status: 200 }));
    const r1 = await runOperation(definition, "current-alert", { alert_type: "cold", region: "South West" }, testContext(empty));
    expect(r1.rows).toEqual([]);
    expect(r1.provenance.basis).toBe("unavailable");
    const notFound = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ detail: "Not found." }), { status: 404 }));
    const r2 = await runOperation(definition, "current-alert", { region: "London" }, testContext(notFound));
    expect(r2.rows).toEqual([]);
    expect(r2.summary).toContain("404");
  });

  it("rejects an unknown region before the network", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "current-alert", { region: "Wales" }, testContext(fetch))).rejects.toThrow();
    await expect(runOperation(definition, "current-alert", { region: "London", alert_type: "storm" }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
