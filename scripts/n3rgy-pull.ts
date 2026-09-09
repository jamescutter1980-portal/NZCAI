/**
 * Pulls n3rgy readings for one MPxN to CSV or JSON.
 *
 *   pnpm n3rgy:pull --mpxn 1234567890123 --utility electricity \
 *       --start 2026-08-01 --end 2026-08-31 [--direction export] [--granularity daily] \
 *       [--out data/exports/readings.csv] [--json]
 *
 * Reads N3RGY_API_KEY, N3RGY_ENV and N3RGY_BASE_URL from the environment or .env.local.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { N3rgyClient, dailyTotals, normaliseConsumption, readingsToCsv } from "../src/lib/integrations/n3rgy";

loadDotEnvLocal();

const args = parseArgs(process.argv.slice(2));
const required = ["mpxn", "utility", "start", "end"] as const;
for (const k of required) {
  if (!args[k]) {
    console.error(`Missing --${k}. Usage: --mpxn <digits> --utility electricity|gas --start YYYY-MM-DD --end YYYY-MM-DD`);
    process.exit(2);
  }
}
const utility = args.utility as "electricity" | "gas";
const direction = (args.direction as "import" | "export") ?? "import";
const granularity = (args.granularity as "halfhour" | "daily") ?? "halfhour";

async function main() {
  const client = new N3rgyClient();
  const query = {
    mpxn: args.mpxn,
    utility,
    start: new Date(`${args.start}T00:00:00Z`),
    end: new Date(`${args.end}T23:59:00Z`),
    granularity,
  };
  console.error(`n3rgy ${client.environment}: ${utility} ${direction} for ${args.mpxn}, ${args.start} to ${args.end}`);
  const raw = direction === "export" ? await client.getProduction(query) : await client.getConsumption(query);
  const readings = normaliseConsumption(query, raw, { direction });
  console.error(`${readings.length} intervals${raw.partial ? " (partial content in at least one chunk)" : ""}`);
  for (const d of dailyTotals(readings)) console.error(`  ${d.date}  ${d.intervals.toString().padStart(3)}  ${d.value.toFixed(3)} ${d.unit}`);

  const output = args.json ? JSON.stringify({ raw: raw.chunks, readings }, null, 2) : readingsToCsv(readings);
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, output);
    console.error(`Written ${args.out}`);
  } else {
    process.stdout.write(output);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  if (e && typeof e === "object" && "body" in e) console.error((e as { body: string }).body);
  process.exit(1);
});

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = "true";
    else {
      out[key] = next;
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
      /* file absent */
    }
  }
}
