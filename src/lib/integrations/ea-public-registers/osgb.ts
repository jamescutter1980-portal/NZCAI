/**
 * WGS84 (lat/lon) to OSGB36 British National Grid easting/northing.
 *
 * Standard seven-parameter Helmert transformation (Ordnance Survey published
 * parameters, WGS84 -> OSGB36) followed by the Transverse Mercator projection
 * of the National Grid on the Airy 1830 ellipsoid. Accuracy is around 5 m,
 * which is enough for a distance search on a public register; it is not a
 * survey-grade transform (OSTN15 is).
 *
 * Source: Ordnance Survey, "A guide to coordinate systems in Great Britain".
 */

const WGS84 = { a: 6378137.0, b: 6356752.3142 };
const AIRY1830 = { a: 6377563.396, b: 6356256.909 };

// WGS84 -> OSGB36 Helmert parameters (metres, arc-seconds, ppm).
const HELMERT = { tx: -446.448, ty: 125.157, tz: -542.06, rx: -0.1502, ry: -0.247, rz: -0.8421, s: 20.4894 };

// National Grid: scale factor on central meridian, true origin, false origin.
const GRID = { F0: 0.9996012717, lat0: (49 * Math.PI) / 180, lon0: (-2 * Math.PI) / 180, N0: -100000, E0: 400000 };

function toCartesian(latDeg: number, lonDeg: number, h: number, e: { a: number; b: number }) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
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

/** Converts a WGS84 latitude/longitude to OSGB36 National Grid easting/northing in metres (rounded to 1 m). */
export function wgs84ToOsgb36(latitude: number, longitude: number): { easting: number; northing: number } {
  const osgb = helmert(toCartesian(latitude, longitude, 0, WGS84));
  const { lat, lon } = toGeodetic(osgb.x, osgb.y, osgb.z, AIRY1830);
  const { a, b } = AIRY1830;
  const { F0, lat0, lon0, N0, E0 } = GRID;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const tanLat = Math.tan(lat);
  const nu = a * F0 / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;
  const M =
    b *
    F0 *
    ((1 + n + (5 / 4) * n * n + (5 / 4) * n * n * n) * (lat - lat0) -
      (3 * n + 3 * n * n + (21 / 8) * n * n * n) * Math.sin(lat - lat0) * Math.cos(lat + lat0) +
      ((15 / 8) * n * n + (15 / 8) * n * n * n) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0)) -
      (35 / 24) * n * n * n * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0)));
  const I = M + N0;
  const II = (nu / 2) * sinLat * cosLat;
  const III = (nu / 24) * sinLat * cosLat ** 3 * (5 - tanLat ** 2 + 9 * eta2);
  const IIIA = (nu / 720) * sinLat * cosLat ** 5 * (61 - 58 * tanLat ** 2 + tanLat ** 4);
  const IV = nu * cosLat;
  const V = (nu / 6) * cosLat ** 3 * (nu / rho - tanLat ** 2);
  const VI = (nu / 120) * cosLat ** 5 * (5 - 18 * tanLat ** 2 + tanLat ** 4 + 14 * eta2 - 58 * tanLat ** 2 * eta2);
  const dLon = lon - lon0;
  const northing = I + II * dLon ** 2 + III * dLon ** 4 + IIIA * dLon ** 6;
  const easting = E0 + IV * dLon + V * dLon ** 3 + VI * dLon ** 5;
  return { easting: Math.round(easting), northing: Math.round(northing) };
}
