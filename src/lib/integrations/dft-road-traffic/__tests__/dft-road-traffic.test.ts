// Fixtures follow the JSON:API-style envelope (data[], links.next) and field names documented for the
// DfT road traffic API and used by open-source clients; not from a live call.
import { describe, expect, it, vi } from "vitest";
import { definition, haversineKm } from "..";
import type { FetchLike } from "../../framework";
import { routedFetch, runOperation, testContext } from "../../testing";

const page1 = {
  data: [
    { count_point_id: 6023, latitude: "51.5010", longitude: "-0.1420", road_name: "A3212", road_category: "PA", road_type: "Major", start_junction_road_name: "A302", end_junction_road_name: "A3213", link_length_km: "0.9", local_authority_id: 71, aadf_year: 2024 },
    { count_point_id: 7001, latitude: "51.5400", longitude: "-0.1000", road_name: "A501", road_category: "PA", road_type: "Major", local_authority_id: 71, aadf_year: 2024 },
  ],
  links: { next: "https://roadtraffic.dft.gov.uk/api/count-points?filter%5Blocal_authority_id%5D=71&page%5Bsize%5D=100&page%5Bnumber%5D=2" },
};
const page2 = { data: [{ count_point_id: 8002, latitude: "51.5030", longitude: "-0.1450", road_name: "C road", road_category: "MCU", road_type: "Minor", local_authority_id: 71, aadf_year: 2019 }], links: { next: null } };
const aadf = {
  data: [
    { count_point_id: 6023, year: 2023, estimation_method: "Estimated", estimation_method_detailed: "Estimated using previous year's AADF on this link", pedal_cycles: 900, two_wheeled_motor_vehicles: 700, cars_and_taxis: 14000, buses_and_coaches: 600, lgvs: 2300, all_hgvs: 400, all_motor_vehicles: 18000, road_name: "A3212" },
    { count_point_id: 6023, year: 2024, estimation_method: "Counted", estimation_method_detailed: "Manual count", pedal_cycles: 950, two_wheeled_motor_vehicles: 720, cars_and_taxis: 14500, buses_and_coaches: 620, lgvs: 2400, all_hgvs: 420, all_motor_vehicles: 18660, road_name: "A3212" },
  ],
};

describe("dft-road-traffic", () => {
  it("pages through a local authority's count points and sorts by distance from a point", async () => {
    const fetch = routedFetch([
      { match: "page%5Bnumber%5D=2", body: page2 },
      { match: "count-points", body: page1 },
    ]);
    const result = await runOperation(definition, "count_points", { local_authority_id: 71, latitude: 51.501, longitude: -0.142, radius_km: 1 }, testContext(fetch));
    expect(result.rows?.map((r) => r.count_point_id)).toEqual([6023, 8002]);
    expect(result.rows?.[0]).toMatchObject({ distance_km: 0, road_name: "A3212", from_junction: "A302" });
    expect(result.summary).toContain("2 count points within 1 km");
    expect(result.provenance).toMatchObject({ source: "dft-road-traffic", basis: "measured", licence: "OGL" });
  });

  it("builds the JSON:API filter URL and lists without a point", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(page2), { status: 200 }));
    const result = await runOperation(definition, "count_points", { local_authority_id: 71 }, testContext(fetch));
    expect(decodeURIComponent(fetch.mock.calls[0][0] as string)).toBe("https://roadtraffic.dft.gov.uk/api/count-points?filter[local_authority_id]=71&page[size]=100&page[number]=1");
    expect(result.rows).toHaveLength(1);
  });

  it("returns AADF latest year first with the estimation method", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(aadf), { status: 200 }));
    const result = await runOperation(definition, "aadf", { count_point_id: 6023 }, testContext(fetch));
    expect(decodeURIComponent(fetch.mock.calls[0][0] as string)).toContain("average-annual-daily-flow?filter[count_point_id]=6023");
    expect(result.rows?.[0]).toMatchObject({ year: 2024, all_motor_vehicles: 18660, all_hgvs: 420, estimation_method: "Counted" });
    expect(result.summary).toContain("18,660 motor vehicles/day in 2024");
    expect(result.provenance.basis).toBe("measured");
  });

  it("handles an empty AADF result and rejects an invalid id before the network", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const result = await runOperation(definition, "aadf", { count_point_id: 1, year: 2010 }, testContext(fetch));
    expect(result.rows).toEqual([]);
    expect(result.provenance.basis).toBe("unavailable");
    const noNet = vi.fn();
    await expect(runOperation(definition, "aadf", { count_point_id: 0 }, testContext(noNet))).rejects.toThrow();
    expect(noNet).not.toHaveBeenCalled();
    expect(haversineKm(51.5, -0.1, 51.5, -0.1)).toBe(0);
  });
});
