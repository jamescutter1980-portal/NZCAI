/**
 * planning.data.gov.uk STUB — INVENTED DATA, NOT THE REAL REGISTER.
 *
 *   node fixtures/planning-data-stub.mjs          # then, in another shell:
 *   PLANNING_DATA_BASE=http://localhost:3900 npm run dev
 *
 * Outbound access to planning.data.gov.uk is blocked in the build environment,
 * so this serves fixture constraint geometry around the sample site at
 * 53.5077, -1.121 (DN4 8DE). It exists so the S-02 map layers can be exercised
 * end to end - present, proximity, a flag with no published extent, and the
 * 15 datasets that return nothing and therefore stay coverage-unknown.
 *
 * Every name and reference below is made up. Do not read anything into them.
 */
import { createServer } from "node:http";

const LAT = 53.5077;
const LNG = -1.121;

/** A square of `half` degrees around a centre, GeoJSON order [lng, lat]. */
const box = (cLng, cLat, half) => ({
  type: "Polygon",
  coordinates: [[
    [cLng - half, cLat - half],
    [cLng + half, cLat - half],
    [cLng + half, cLat + half],
    [cLng - half, cLat + half],
    [cLng - half, cLat - half],
  ]],
});

// Contains the site.
const CONTAINING = {
  "conservation-area": {
    name: "Balby Road Conservation Area",
    reference: "CA-014",
    geometry: box(LNG, LAT, 0.0016),
  },
  "green-belt": {
    name: "South Yorkshire Green Belt",
    reference: "GB-SY-03",
    geometry: box(LNG + 0.001, LAT, 0.004),
  },
  // Flagged, but the publisher exposes no extent — exercises the
  // "flagged but published no extent to draw" path.
  "heritage-at-risk": {
    name: "Register entry 1290114",
    reference: "HAR-1290114",
    geometry: null,
  },
};

// Near the site but not on it: only returned for the buffered query.
const NEARBY = {
  "listed-building": {
    name: "Former Co-operative Hall (Grade II)",
    reference: "LB-1290114",
    geometry: box(LNG - 0.0009, LAT + 0.0007, 0.00025),
  },
  "flood-risk-zone": {
    name: "Flood Zone 2",
    reference: "FZ2-DN4",
    geometry: box(LNG + 0.0012, LAT - 0.0010, 0.0006),
  },
  "tree-preservation-zone": {
    name: "TPO 1998/14",
    reference: "TPO-1998-14",
    geometry: box(LNG - 0.0011, LAT - 0.0008, 0.0003),
  },
};

const feature = (dataset, e) => ({
  type: "Feature",
  geometry: e.geometry,
  properties: {
    entity: Math.floor(Math.random() * 1e6),
    dataset,
    reference: e.reference,
    name: e.name,
    "entry-date": "2026-02-14",
  },
});

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/dataset.json") {
    const all = [...Object.keys(CONTAINING), ...Object.keys(NEARBY)];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ datasets: all.map((d) => ({ dataset: d })) }));
    return;
  }

  if (url.pathname === "/entity.geojson") {
    const wanted = url.searchParams.getAll("dataset");
    const wkt = url.searchParams.get("geometry") ?? "";

    // The proximity pass queries a larger envelope. Distinguish the two passes
    // by the area of the WKT the caller sent.
    const nums = [...wkt.matchAll(/-?\d+\.?\d*/g)].map((m) => Number(m[0]));
    const lngs = nums.filter((_, i) => i % 2 === 0);
    const lats = nums.filter((_, i) => i % 2 === 1);
    const span = lngs.length
      ? Math.max(...lngs) - Math.min(...lngs) + (Math.max(...lats) - Math.min(...lats))
      : 0;
    const isBuffered = span > 0.0025;

    const source = isBuffered ? { ...CONTAINING, ...NEARBY } : CONTAINING;
    const features = wanted
      .filter((d) => source[d])
      .map((d) => feature(d, source[d]));

    console.log(
      `  ${isBuffered ? "buffered" : "site    "} pass: ${wanted.length} datasets asked, ` +
      `${features.length} returned (${features.map((f) => f.properties.dataset).join(", ") || "none"})`,
    );

    res.writeHead(200, { "content-type": "application/geo+json" });
    res.end(JSON.stringify({ type: "FeatureCollection", features }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(3900, () => console.log("planning.data stub on http://localhost:3900"));
