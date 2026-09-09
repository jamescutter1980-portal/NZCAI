// Entity fields mirror the response shape used by the planning.data.gov.uk
// /entity.json endpoint as captured in the Open Systems Lab PlanX mocks
// (theopensystemslab/planx-new). Counts in datasets.json are illustrative.
import { describe, expect, it, vi } from "vitest";
import { CONSTRAINT_DATASETS, definition, entityUrl } from "..";
import type { FetchLike } from "../../framework";
import { runOperation, testContext } from "../../testing";
import constraints from "./fixtures/constraints-point.json";
import datasets from "./fixtures/datasets.json";

describe("planning-data", () => {
  it("queries all standard datasets at a point in one request with repeated dataset params", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(constraints), { status: 200 }));
    const result = await runOperation(definition, "constraints-at-point", { latitude: 51.4947, longitude: -0.1204 }, testContext(fetch));
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://www.planning.data.gov.uk/entity.json");
    expect(url.searchParams.getAll("dataset")).toEqual(CONSTRAINT_DATASETS.map((d) => d.id));
    expect(url.searchParams.get("latitude")).toBe("51.4947");
    expect(url.searchParams.get("longitude")).toBe("-0.1204");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(result.rows).toHaveLength(3);
    expect(result.rows?.[0]).toMatchObject({ dataset: "listed-building", reference: "1080374", grade_or_level: "II", entity_url: "https://www.planning.data.gov.uk/entity/31537854", documentation_url: "https://historicengland.org.uk/listing/the-list/list-entry/1080374" });
    expect(result.rows?.[2]).toMatchObject({ dataset: "flood-risk-zone", grade_or_level: "3", name: null });
    expect(result.summary).toContain("3 constraints");
    expect(result.summary).toContain("Listed building");
    expect(result.summary).toContain(`No hits in ${CONSTRAINT_DATASETS.length - 3} of ${CONSTRAINT_DATASETS.length} datasets`);
    expect(result.provenance).toMatchObject({ source: "planning-data", basis: "measured", licence: "OGL", territory: "England" });
  });

  it("accepts a custom dataset list and reports no hits as unavailable", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ count: 0, entities: [] }), { status: 200 }));
    const result = await runOperation(definition, "constraints-at-point", { latitude: 54.1, longitude: -1.2, datasets: "green-belt, national-park" }, testContext(fetch));
    expect(new URL(fetch.mock.calls[0][0] as string).searchParams.getAll("dataset")).toEqual(["green-belt", "national-park"]);
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    expect(result.warnings?.[0]).toMatch(/Completeness varies/);
  });

  it("searches a dataset by name with q", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ count: 1, entities: [constraints.entities[1]] }), { status: 200 }));
    const result = await runOperation(definition, "search-dataset", { dataset: "conservation-area", query: "Lambeth" }, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe(entityUrl({ q: "Lambeth", entries: "current", limit: 25, exclude_field: "geometry" }, ["conservation-area"]));
    expect(result.rows?.[0]).toMatchObject({ dataset: "conservation-area", name: "Lambeth Palace", reference: "CA12" });
  });

  it("lists datasets", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(datasets), { status: 200 }));
    const result = await runOperation(definition, "list-datasets", {}, testContext(fetch));
    expect(fetch.mock.calls[0][0]).toBe("https://www.planning.data.gov.uk/dataset.json");
    expect(result.rows?.[1]).toMatchObject({ dataset: "listed-building", entity_count: 378000, themes: "heritage" });
  });

  it("rejects bad coordinates, bad dataset ids and unknown select values before any request", async () => {
    const fetch = vi.fn();
    await expect(runOperation(definition, "constraints-at-point", { latitude: "x", longitude: 0 }, testContext(fetch))).rejects.toThrow();
    await expect(runOperation(definition, "constraints-at-point", { latitude: 51, longitude: 0, datasets: "Green Belt!" }, testContext(fetch))).rejects.toThrow(/slugs/);
    await expect(runOperation(definition, "search-dataset", { dataset: "not-a-dataset", query: "x" }, testContext(fetch))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
