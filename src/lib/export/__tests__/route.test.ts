import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, setDb, type Db } from "@/lib/db/sqlite";
import { AssetsRepository } from "@/lib/assets/repo";
import { ReadingsRepository } from "@/lib/db/readings-repo";
import { setConsentStore } from "@/lib/consent/registry";
import type { ConsentStore } from "@/lib/consent/store";
import type { ConsentRecord } from "@/lib/consent/types";
import { GET } from "@/app/api/exports/[kind]/route";

// Synthetic factors again; see builders.test.ts.
const DESNZ_CSV = `ID,Scope,Level 1,Level 2,Level 3,Level 4,Column Text,UOM,GHG/Unit,GHG Conversion Factor 2025
1,Scope 2,UK electricity,Electricity generated,,,,kWh,kg CO2e,0.111
2,Scope 3,Transmission and distribution,T&D- UK electricity,,,,kWh,kg CO2e,0.011
3,Scope 1,Fuels,Gaseous fuels,Natural gas,,,kWh (Gross CV),kg CO2e,0.222
`;

const CONSENT: ConsentRecord = {
  id: "c1", mpxn: "1000000000001", utilities: ["electricity"], occupierName: "Tenant Ltd",
  method: "letter_of_authority", grantedOn: "2026-01-01", expiresOn: "2026-12-31", status: "active",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

const stubStore = {
  list: async () => [CONSENT],
  get: async () => undefined,
  findByMpxn: async () => [],
  create: async () => CONSENT,
  update: async () => CONSENT,
} as unknown as ConsentStore;

let dir: string;
let db: Db;
let assetId: string;
let previousReferenceDir: string | undefined;

const call = (kind: string, query = "") =>
  GET(new Request(`http://localhost/api/exports/${kind}${query}`), { params: Promise.resolve({ kind }) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "export-route-"));
  mkdirSync(join(dir, "desnz-conversion-factors"), { recursive: true });
  writeFileSync(join(dir, "desnz-conversion-factors", "2025.csv"), DESNZ_CSV);
  previousReferenceDir = process.env.REFERENCE_DATA_DIR;
  process.env.REFERENCE_DATA_DIR = dir;

  db = openDatabase(":memory:");
  setDb(db);
  setConsentStore(stubStore);
  const repo = new AssetsRepository(db);
  assetId = repo.create({ name: "Alpha House", postcode: "SW1A1AA", floorAreaM2: 1000 }).id;
  repo.linkMeter(assetId, { mpxn: "1000000000001", utility: "electricity", direction: "import", share: 1 });
  const provenance = { source: "n3rgy", dataset: "d", retrievedAt: "2026-01-01T00:00:00.000Z", territory: "GB", licence: "consent_based" as const, attribution: "a", basis: "measured" as const, consentRef: "c1" };
  new ReadingsRepository(db).upsertReadings(
    ["2025-03-01T00:00:00.000Z", "2024-03-01T00:00:00.000Z"].map((intervalStart) => ({
      mpxn: "1000000000001", utility: "electricity" as const, direction: "import" as const,
      intervalStart, intervalEnd: new Date(Date.parse(intervalStart) + 1_800_000).toISOString(), value: 100, unit: "kWh", provenance,
    })),
  );
});

afterEach(() => {
  setDb(undefined);
  setConsentStore(undefined);
  db.close();
  if (previousReferenceDir === undefined) delete process.env.REFERENCE_DATA_DIR;
  else process.env.REFERENCE_DATA_DIR = previousReferenceDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/exports/[kind]", () => {
  it("serves CSV as an attachment with a BOM by default", async () => {
    const res = await call("readings", "?mpxn=1000000000001&utility=electricity&start=2025-03-01&end=2025-03-01");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="readings-1000000000001-electricity-import-2025-03-01-to-2025-03-01.csv"');
    expect(res.headers.get("x-export-rows")).toBe("1");
    expect(res.headers.get("x-export-truncated")).toBeNull();
    // Response.text() performs a UTF-8 decode, which strips the BOM, so check the bytes.
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const body = bytes.toString("utf8");
    expect(body).toContain("\r\n1000000000001,electricity,import,2025-03-01T00:00:00.000Z");
    expect(body.endsWith("\r\n")).toBe(true);
  });

  it("omits the BOM when asked", async () => {
    const res = await call("readings", "?mpxn=1000000000001&utility=electricity&start=2025-03-01&end=2025-03-01&bom=false");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bytes.toString("utf8").startsWith("mpxn,")).toBe(true);
  });

  it("serves every other kind", async () => {
    for (const [kind, query] of [
      ["asset-carbon", `?year=2025&asset=${assetId}`],
      ["portfolio-energy", "?year=2025"],
      ["portfolio-carbon", "?year=2025"],
      ["secr-summary", "?year=2025"],
      ["consents", ""],
    ] as const) {
      const res = await call(kind, query);
      expect(res.status, kind).toBe(200);
      expect(res.headers.get("x-export-kind")).toBe(kind);
      expect((await res.text()).length).toBeGreaterThan(0);
    }
  });

  it("returns 400 with the zod issues for bad params", async () => {
    const bad = await call("readings", "?mpxn=abc&utility=coal&start=01-01-2025&end=2025-01-31");
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.error).toBe("Invalid query");
    expect(body.issues.map((i: { path: string[] }) => i.path[0]).sort()).toEqual(["mpxn", "start", "utility"]);

    expect((await call("readings", "?mpxn=1000000000001&utility=electricity&start=2025-03-05&end=2025-03-01")).status).toBe(400);
    expect((await call("portfolio-energy", "?year=1999")).status).toBe(400);
    expect((await call("portfolio-energy")).status).toBe(400);
    expect((await call("asset-carbon", "?year=2025")).status).toBe(400);
  });

  it("returns 404 for an unknown kind or an unknown asset", async () => {
    const kind = await call("nonsense", "?year=2025");
    expect(kind.status).toBe(404);
    expect((await kind.json()).error).toMatch(/Unknown export kind/);

    const asset = await call("asset-carbon", "?year=2025&asset=no-such-asset");
    expect(asset.status).toBe(404);
    expect((await asset.json()).error).toMatch(/not found/);
  });

  it("does not throw when the reference data is missing; it blanks the factor cells", async () => {
    // Only the 2025 factor file exists, so 2025 energy is priced and 2024 energy is not.
    const res = await call("asset-carbon", `?year=2024&asset=${assetId}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/No DESNZ 2024 flat file loaded \(loaded: 2025\)\./);
    expect(body).toMatch(/No AIB residual mix file loaded\./);
    // Every data row ends "<blank kgCO2e>,<reason>"; none of them ends in a fabricated 0.
    for (const line of body.trimEnd().split("\r\n").slice(1)) {
      expect(line).toMatch(/,,No .*\.$/);
    }
  });
});
