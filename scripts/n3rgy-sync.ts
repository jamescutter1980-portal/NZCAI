/**
 * Runs the n3rgy sync for every active consent.
 *
 *   pnpm n3rgy:sync [--mpxn 1234567890123] [--no-export] [--no-tariff] [--backfill-days 395]
 *
 * Schedule it daily (cron, systemd timer, Windows Task Scheduler) or call the
 * /api/n3rgy/sync route from a hosted scheduler.
 */
import { readFileSync } from "node:fs";
import { getConsentStore } from "../src/lib/consent";
import { getDb } from "../src/lib/db/sqlite";
import { N3rgyClient } from "../src/lib/integrations/n3rgy";
import { runN3rgySync, summariseRun } from "../src/lib/sync";

loadDotEnvLocal();
const args = parseArgs(process.argv.slice(2));

async function main() {
  const client = new N3rgyClient();
  const run = await runN3rgySync(
    { db: getDb(), store: getConsentStore(), client },
    {
      trigger: "cli",
      mpxn: args.mpxn,
      includeExport: args["no-export"] !== "true",
      includeTariff: args["no-tariff"] !== "true",
      backfillDays: args["backfill-days"] ? Number(args["backfill-days"]) : undefined,
    },
  );
  console.log(`Sync ${run.id} (${run.environment}): ${summariseRun(run)}`);
  for (const i of run.items) {
    const status = i.error ? `ERROR ${i.error}` : `${i.readingsUpserted} readings, ${i.tariffRows} tariff rows, ${i.gaps.length} gaps${i.warning ? `, ${i.warning}` : ""}`;
    console.log(`  ${i.mpxn} ${i.utility} ${i.direction}: ${status}`);
  }
  for (const w of run.warnings) console.log(`  warning: ${w}`);
  process.exit(run.summary.errors > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
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
