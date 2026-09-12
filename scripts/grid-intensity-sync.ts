/**
 * Backfills half-hourly regional grid carbon intensity for every asset with a
 * postcode, covering the date range of its stored electricity readings (or
 * --from/--to). Needed for the time-varying carbon figure on the asset page.
 *
 *   pnpm carbon:intensity [--asset <id>] [--from YYYY-MM-DD --to YYYY-MM-DD]
 */
import { readFileSync } from "node:fs";
import { AssetsRepository } from "../src/lib/assets";
import { syncGridIntensity } from "../src/lib/carbon";
import { ReadingsRepository } from "../src/lib/db/readings-repo";
import { getDb } from "../src/lib/db/sqlite";
import { defaultContext } from "../src/lib/integrations/framework";

loadDotEnvLocal();
const args = parseArgs(process.argv.slice(2));

async function main() {
  const db = getDb();
  const assets = new AssetsRepository(db);
  const readings = new ReadingsRepository(db);
  const ctx = defaultContext();
  const targets = assets.list().filter((a) => a.postcode && (!args.asset || a.id === args.asset));
  if (targets.length === 0) {
    console.log("No assets with a postcode.");
    return;
  }
  let failures = 0;
  for (const a of targets) {
    let from = args.from;
    let to = args.to;
    if (!from || !to) {
      const meters = assets.meters(a.id).filter((m) => m.utility === "electricity" && m.direction === "import");
      const spans = meters.map((m) => readings.listMeters().find((x) => x.mpxn === m.mpxn && x.utility === "electricity" && x.direction === "import")).filter(Boolean) as { first: string; last: string }[];
      if (spans.length === 0) {
        console.log(`${a.name}: no electricity readings; skipped`);
        continue;
      }
      from = spans.map((s) => s.first).sort()[0].slice(0, 10);
      to = spans.map((s) => s.last).sort().reverse()[0].slice(0, 10);
    }
    try {
      const r = await syncGridIntensity(db, ctx, a.postcode!, from, to);
      console.log(`${a.name} (${r.region}): ${r.rows} half hours from ${from} to ${to} in ${r.batches} batches`);
    } catch (e) {
      failures += 1;
      console.error(`${a.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[argv[i].slice(2)] = "true";
    else {
      out[argv[i].slice(2)] = next;
      i++;
    }
  }
  return out;
}

function loadDotEnvLocal() {
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {
      /* absent */
    }
  }
}
