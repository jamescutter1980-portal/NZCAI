/**
 * Health-checks every registered data source from this machine.
 *
 *   pnpm sources:check            configured sources only
 *   pnpm sources:check --all      include unconfigured (reports missing env)
 *   pnpm sources:check --id epc-england-wales
 *
 * Prints one line per source and exits 1 if any configured check failed.
 */
import { readFileSync } from "node:fs";
import { defaultContext, checkConfigured } from "../src/lib/integrations/framework";
import { integrations } from "../src/lib/integrations/registry";
import { runHealth } from "../src/lib/integrations/service";

loadDotEnvLocal();
const args = process.argv.slice(2);
const all = args.includes("--all");
const only = args.includes("--id") ? args[args.indexOf("--id") + 1] : undefined;

async function main() {
  const ctx = defaultContext();
  let failures = 0;
  const rows: string[] = [];
  const targets = integrations.filter((d) => (only ? d.id === only : true));
  for (const def of targets) {
    const cfg = checkConfigured(def, ctx.env);
    if (!cfg.configured && !all) {
      rows.push(`SKIP  ${def.id.padEnd(36)} needs ${cfg.missing.join(", ")}`);
      continue;
    }
    if (def.status === "reference_only" || !def.healthCheck) {
      rows.push(`----  ${def.id.padEnd(36)} ${def.status === "reference_only" ? "reference only" : "no health check"}`);
      continue;
    }
    const r = await runHealth(def.id, ctx);
    if (!r.ok && cfg.configured) failures += 1;
    rows.push(`${r.ok ? "OK  " : "FAIL"}  ${def.id.padEnd(36)} ${r.detail}${r.latencyMs !== undefined ? ` (${r.latencyMs} ms)` : ""}`);
  }
  console.log(rows.join("\n"));
  console.log(`\n${targets.length} sources, ${failures} failures`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

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
