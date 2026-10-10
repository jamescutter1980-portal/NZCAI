/**
 * Manages clients, their assets and their API keys.
 *
 *   pnpm api-keys clients
 *   pnpm api-keys add-client "Logicor"
 *   pnpm api-keys assets [client]                 every asset with its client, or one client's
 *   pnpm api-keys assign <client> <assetId>...    put assets in a client's portfolio
 *   pnpm api-keys unassign <assetId>...           take them out again
 *   pnpm api-keys issue <client> --label "Power BI refresh" [--expires 2027-10-01]
 *   pnpm api-keys keys [client]
 *   pnpm api-keys revoke <keyId>
 *
 * <client> is the client's id or name. A key is printed once, when issued,
 * and cannot be shown again; issue a new one and revoke the old if it is lost.
 * Keys are kept off the web UI on purpose: only someone with shell access to
 * the portal's database can create one.
 */
import { readFileSync } from "node:fs";
import { getDb } from "../src/lib/db/sqlite";
import { AssetsRepository } from "../src/lib/assets/repo";
import { ApiKeysRepository, keyStatus, type Client } from "../src/lib/api-keys/repo";

loadDotEnvLocal();
const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;

const db = getDb();
const keys = new ApiKeysRepository(db);
const assets = new AssetsRepository(db);

function client(ref: string | undefined): Client {
  if (!ref) fail("Name the client by id or name.");
  const c = keys.findClient(ref);
  if (!c) fail(`No client "${ref}". Run "pnpm api-keys clients" to list them.`);
  return c;
}

function main() {
  switch (command) {
    case "clients": {
      const clients = keys.listClients();
      if (clients.length === 0) console.log('No clients yet. Add one with: pnpm api-keys add-client "Name"');
      for (const c of clients) {
        const n = assets.list({ clientId: c.id }).length;
        const active = keys.listKeys(c.id).filter((k) => keyStatus(k) === "active").length;
        console.log(`${c.id}  ${c.name}  (${n} asset${n === 1 ? "" : "s"}, ${active} active key${active === 1 ? "" : "s"})`);
      }
      return;
    }
    case "add-client": {
      const c = keys.createClient(rest.join(" "));
      console.log(`Created client ${c.name} (${c.id}).`);
      return;
    }
    case "assets": {
      const scoped = rest[0] ? client(rest[0]) : undefined;
      const names = new Map(keys.listClients().map((c) => [c.id, c.name]));
      for (const a of assets.list(scoped ? { clientId: scoped.id } : {})) {
        console.log(`${a.id}  ${a.name}  [${a.clientId ? names.get(a.clientId) : "no client"}]`);
      }
      return;
    }
    case "assign": {
      const c = client(rest[0]);
      const ids = rest.slice(1);
      if (ids.length === 0) fail("Give at least one asset id.");
      for (const id of ids) assets.assignClient(id, c.id);
      console.log(`Assigned ${ids.length} asset${ids.length === 1 ? "" : "s"} to ${c.name}.`);
      return;
    }
    case "unassign": {
      if (rest.length === 0) fail("Give at least one asset id.");
      for (const id of rest) assets.assignClient(id, null);
      console.log(`Unassigned ${rest.length} asset${rest.length === 1 ? "" : "s"}.`);
      return;
    }
    case "issue": {
      const c = client(rest[0]);
      if (!flags.label) fail('Give the key a --label naming what will use it, e.g. --label "Power BI refresh".');
      const expiresAt = flags.expires ? parseExpiry(flags.expires) : undefined;
      const { key, secret } = keys.issueKey(c.id, { label: flags.label, expiresAt });
      const count = assets.list({ clientId: c.id }).length;
      console.log(`Issued key ${key.id} for ${c.name} (${key.label})${expiresAt ? `, expires ${expiresAt}` : ""}.`);
      console.log("");
      console.log(`  ${secret}`);
      console.log("");
      console.log("This is the only time the key is shown. Send it to the client by a secure channel.");
      if (count === 0) console.log(`Warning: ${c.name} has no assets yet, so this key will return nothing until some are assigned.`);
      return;
    }
    case "keys": {
      const scoped = rest[0] ? client(rest[0]) : undefined;
      const names = new Map(keys.listClients().map((c) => [c.id, c.name]));
      for (const k of keys.listKeys(scoped?.id)) {
        const used = k.lastUsedAt ? `last used ${k.lastUsedAt}` : "never used";
        console.log(`${k.id}  ${names.get(k.clientId)}  "${k.label}"  ...${k.hint}  ${keyStatus(k)}  ${used}${k.expiresAt ? `  expires ${k.expiresAt}` : ""}`);
      }
      return;
    }
    case "revoke": {
      if (!rest[0]) fail("Give the key id to revoke.");
      console.log(keys.revokeKey(rest[0]) ? `Revoked ${rest[0]}.` : `No active key ${rest[0]}.`);
      return;
    }
    default:
      fail("Commands: clients, add-client, assets, assign, unassign, issue, keys, revoke. See the top of scripts/api-keys.ts.");
  }
}

/** A date means the end of that day UTC, so "expires 2027-10-01" still works on the 1st. */
function parseExpiry(value: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
  const ms = Date.parse(day);
  if (Number.isNaN(ms)) fail(`--expires must be a date such as 2027-10-01, not "${value}".`);
  return new Date(ms).toISOString();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

try {
  main();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) flags[a.slice(2)] = "true";
    else {
      flags[a.slice(2)] = next;
      i++;
    }
  }
  return { positional, flags };
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
