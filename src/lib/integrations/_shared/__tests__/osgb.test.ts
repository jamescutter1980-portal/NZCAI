import { describe, expect, it } from "vitest";
import { wgs84ToOsgb36 } from "../../ea-public-registers/osgb";
import { osgb36ToWgs84 } from "../osgb";

/** Metres between two WGS84 points (equirectangular; fine at sub-kilometre scale). */
function metres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const x = (toRad(lon2) - toRad(lon1)) * Math.cos((toRad(lat1) + toRad(lat2)) / 2);
  const y = toRad(lat2) - toRad(lat1);
  return Math.sqrt(x * x + y * y) * R;
}

describe("osgb36ToWgs84", () => {
  // Reference centroid for SW1A 1AA from the ONS Postcode Directory (as used by
  // the forward transform's own test): 529090, 179645 <-> 51.501009, -0.141588.
  it("matches the SW1A 1AA centroid to within a few metres", () => {
    const p = osgb36ToWgs84(529090, 179645)!;
    expect(metres(p.latitude, p.longitude, 51.501009, -0.141588)).toBeLessThan(8);
  });

  it("round-trips against the forward transform within 1 m at two points", () => {
    // Integer grid references are the fixed points here, so the forward
    // transform's 1 m rounding cannot mask a real error.
    for (const [e, n] of [
      [529090, 179645], // central London
      [383800, 398300], // Manchester area
    ]) {
      const ll = osgb36ToWgs84(e, n)!;
      const back = wgs84ToOsgb36(ll.latitude, ll.longitude);
      expect(Math.abs(back.easting - e)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.northing - n)).toBeLessThanOrEqual(1);
    }
  });

  it("round-trips a lat/lon through forward then inverse within 1 m", () => {
    for (const [lat, lon] of [
      [55.95, -3.19], // Edinburgh
      [50.72, -3.53], // Exeter
    ]) {
      const grid = wgs84ToOsgb36(lat, lon);
      const back = osgb36ToWgs84(grid.easting, grid.northing)!;
      expect(metres(lat, lon, back.latitude, back.longitude)).toBeLessThan(1);
    }
  });

  it("returns null outside the National Grid extent or for non-finite input", () => {
    expect(osgb36ToWgs84(-5, 100)).toBeNull();
    expect(osgb36ToWgs84(900_000, 100)).toBeNull();
    expect(osgb36ToWgs84(Number.NaN, 100)).toBeNull();
  });
});
