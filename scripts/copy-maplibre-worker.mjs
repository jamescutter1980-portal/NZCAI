/**
 * MapLibre v6 loads its worker as a module worker:
 *   new Worker(url, { type: "module" })
 * and that worker imports "./maplibre-gl-shared.mjs" as a sibling. Neither
 * Turbopack nor webpack emits that pair in a way the browser can resolve, so
 * the worker never starts, GeoJSON sources never parse, and nothing renders.
 *
 * Copying both files to public/ and pointing setWorkerUrl() at them is the
 * supported escape hatch. Runs before dev and build; re-run after upgrading
 * maplibre-gl so the copies never drift from the installed version.
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "node_modules", "maplibre-gl", "dist");
const outDir = join(root, "public", "maplibre");
const files = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

mkdirSync(outDir, { recursive: true });
for (const file of files) {
  copyFileSync(join(dist, file), join(outDir, file));
}

const { version } = JSON.parse(
  readFileSync(join(root, "node_modules", "maplibre-gl", "package.json"), "utf8"),
);
console.log(`maplibre worker ${version} -> public/maplibre/ (${files.length} files)`);
