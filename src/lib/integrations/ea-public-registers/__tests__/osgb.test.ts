import { describe, expect, it } from "vitest";
import { wgs84ToOsgb36 } from "../osgb";

describe("wgs84ToOsgb36", () => {
  // Reference points are postcodes.io centroids (ONS Postcode Directory), which
  // carry both WGS84 and OSGB36 coordinates for the same location.
  it("matches the SW1A 1AA centroid to within a few metres", () => {
    const { easting, northing } = wgs84ToOsgb36(51.501009, -0.141588);
    expect(Math.abs(easting - 529090)).toBeLessThanOrEqual(6);
    expect(Math.abs(northing - 179645)).toBeLessThanOrEqual(6);
  });

  it("is monotonic east and north", () => {
    const a = wgs84ToOsgb36(53.4, -2.2);
    const b = wgs84ToOsgb36(53.4, -2.1);
    const c = wgs84ToOsgb36(53.5, -2.2);
    expect(b.easting).toBeGreaterThan(a.easting);
    expect(c.northing).toBeGreaterThan(a.northing);
  });
});
