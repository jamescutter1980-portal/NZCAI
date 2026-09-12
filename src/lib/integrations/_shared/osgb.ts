/**
 * OSGB36 British National Grid easting/northing to WGS84 latitude/longitude.
 *
 * Inverse of `ea-public-registers/osgb.ts` (which is left untouched): the
 * Transverse Mercator inverse on the Airy 1830 ellipsoid, then the
 * seven-parameter Helmert transformation OSGB36 -> WGS84 (the published
 * WGS84 -> OSGB36 parameters with their signs reversed). Accuracy is around
 * 5 m, the same as the forward transform; not survey grade (OSTN15 is).
 *
 * Source: Ordnance Survey, "A guide to coordinate systems in Great Britain",
 * annexes B and C.
 */

const WGS84 = { a: 6378137.0, b: 6356752.3142 };
const AIRY1830 = { a: 6377563.396, b: 6356256.909 };

// OSGB36 -> WGS84: the WGS84 -> OSGB36 parameters (-446.448, 125.157, -542.06,
// -0.1502, -0.247, -0.8421, 20.4894) with signs reversed.
const HELMERT = { tx: 446.448, ty: -125.157, tz: 542.06, rx: 0.1502, ry: 0.247, rz: 0.8421, s: -20.4894 };

const GRID = { F0: 0.9996012717, lat0: (49 * Math.PI) / 180, lon0: (-2 * Math.PI) / 180, N0: -100000, E0: 400000 };

function toCartesian(lat: number, lon: number, h: number, e: { a: number; b: number }) {
  const e2 = 1 - (e.b * e.b) / (e.a * e.a);
  const nu = e.a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return {
    x: (nu + h) * Math.cos(lat) * Math.cos(lon),
    y: (nu + h) * Math.cos(lat) * Math.sin(lon),
    z: ((1 - e2) * nu + h) * Math.sin(lat),
  };
}

function toGeodetic(x: number, y: number, z: number, e: { a: number; b: number }) {
  const e2 = 1 - (e.b * e.b) / (e.a * e.a);
  const p = Math.sqrt(x * x + y * y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const nu = e.a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    const next = Math.atan2(z + e2 * nu * Math.sin(lat), p);
    if (Math.abs(next - lat) < 1e-12) {
      lat = next;
      break;
    }
    lat = next;
  }
  return { lat, lon: Math.atan2(y, x) };
}

function helmert(c: { x: number; y: number; z: number }) {
  const s = 1 + HELMERT.s * 1e-6;
  const rx = (HELMERT.rx / 3600) * (Math.PI / 180);
  const ry = (HELMERT.ry / 3600) * (Math.PI / 180);
  const rz = (HELMERT.rz / 3600) * (Math.PI / 180);
  return {
    x: HELMERT.tx + s * c.x - rz * c.y + ry * c.z,
    y: HELMERT.ty + rz * c.x + s * c.y - rx * c.z,
    z: HELMERT.tz - ry * c.x + rx * c.y + s * c.z,
  };
}

/** Meridional arc from the true origin to `lat` on the Airy ellipsoid (OS guide, equation C3). */
function meridionalArc(lat: number): number {
  const { a, b } = AIRY1830;
  const { F0, lat0 } = GRID;
  const n = (a - b) / (a + b);
  return (
    b *
    F0 *
    ((1 + n + (5 / 4) * n * n + (5 / 4) * n * n * n) * (lat - lat0) -
      (3 * n + 3 * n * n + (21 / 8) * n * n * n) * Math.sin(lat - lat0) * Math.cos(lat + lat0) +
      ((15 / 8) * n * n + (15 / 8) * n * n * n) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0)) -
      (35 / 24) * n * n * n * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0)))
  );
}

/** OSGB36 easting/northing (metres) to OSGB36 geodetic latitude/longitude (radians). */
function gridToOsgb36LatLon(easting: number, northing: number): { lat: number; lon: number } {
  const { a } = AIRY1830;
  const { F0, lat0, lon0, N0, E0 } = GRID;
  const e2 = 1 - (AIRY1830.b * AIRY1830.b) / (a * a);
  let lat = (northing - N0) / (a * F0) + lat0;
  for (let i = 0; i < 20; i++) {
    const M = meridionalArc(lat);
    if (Math.abs(northing - N0 - M) < 0.00001) break;
    lat = (northing - N0 - M) / (a * F0) + lat;
  }
  const sinLat = Math.sin(lat);
  const tanLat = Math.tan(lat);
  const secLat = 1 / Math.cos(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;
  const VII = tanLat / (2 * rho * nu);
  const VIII = (tanLat / (24 * rho * nu ** 3)) * (5 + 3 * tanLat ** 2 + eta2 - 9 * tanLat ** 2 * eta2);
  const IX = (tanLat / (720 * rho * nu ** 5)) * (61 + 90 * tanLat ** 2 + 45 * tanLat ** 4);
  const X = secLat / nu;
  const XI = (secLat / (6 * nu ** 3)) * (nu / rho + 2 * tanLat ** 2);
  const XII = (secLat / (120 * nu ** 5)) * (5 + 28 * tanLat ** 2 + 24 * tanLat ** 4);
  const XIIA = (secLat / (5040 * nu ** 7)) * (61 + 662 * tanLat ** 2 + 1320 * tanLat ** 4 + 720 * tanLat ** 6);
  const dE = easting - E0;
  return {
    lat: lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6,
    lon: lon0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7,
  };
}

/**
 * Converts an OSGB36 National Grid easting/northing (metres) to a WGS84
 * latitude/longitude in decimal degrees (rounded to 6 dp, about 0.1 m).
 * Returns null for coordinates outside the National Grid's usable extent.
 */
export function osgb36ToWgs84(easting: number, northing: number): { latitude: number; longitude: number } | null {
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;
  if (easting < 0 || easting > 800_000 || northing < 0 || northing > 1_400_000) return null;
  const { lat, lon } = gridToOsgb36LatLon(easting, northing);
  const wgs = helmert(toCartesian(lat, lon, 0, AIRY1830));
  const g = toGeodetic(wgs.x, wgs.y, wgs.z, WGS84);
  const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return { latitude: round6((g.lat * 180) / Math.PI), longitude: round6((g.lon * 180) / Math.PI) };
}
