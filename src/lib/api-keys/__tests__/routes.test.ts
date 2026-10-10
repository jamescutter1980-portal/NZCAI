import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, setDb, type Db } from "@/lib/db/sqlite";
import { AssetsRepository } from "@/lib/assets/repo";
import { setConsentStore } from "@/lib/consent/registry";
import type { ConsentStore } from "@/lib/consent/store";
import { ApiKeysRepository } from "../repo";
import { GET as listAssets } from "@/app/api/assets/route";
import { GET as getAsset } from "@/app/api/assets/[id]/route";
import { GET as getCarbon } from "@/app/api/assets/[id]/carbon/route";
import { GET as getAssessment } from "@/app/api/assets/[id]/assessment/route";
import { GET as getPortfolio } from "@/app/api/portfolio/route";
import { GET as getExport } from "@/app/api/exports/[kind]/route";

/**
 * The point of a client key is that it cannot see another client's assets.
 * Logicor holds one asset, another client holds one, and one belongs to
 * nobody; a Logicor key must only ever surface the first.
 */

const stubStore = { findByMpxn: async () => [] } as unknown as ConsentStore;

let db: Db;
let mine: string;
let theirs: string;
let unassigned: string;
let key: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  setDb(db);
  setConsentStore(stubStore);
  const assets = new AssetsRepository(db);
  const keys = new ApiKeysRepository(db);
  const logicor = keys.createClient("Logicor");
  const other = keys.createClient("Other Fund");
  mine = assets.create({ name: "Logicor Shed", postcode: "NN46AA", floorAreaM2: 10000, notes: "internal: fee dispute" }).id;
  theirs = assets.create({ name: "Other Office", postcode: "SW1A1AA" }).id;
  unassigned = assets.create({ name: "Unassigned" }).id;
  assets.assignClient(mine, logicor.id);
  assets.assignClient(theirs, other.id);
  key = keys.issueKey(logicor.id, { label: "Power BI" }).secret;
});

afterEach(() => {
  setDb(undefined);
  setConsentStore(undefined);
  db.close();
});

const req = (path: string, auth?: string) => new Request(`http://localhost${path}`, auth ? { headers: { authorization: auth } } : undefined);
const bearer = (k = key) => `Bearer ${k}`;
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const kindParams = (kind: string) => ({ params: Promise.resolve({ kind }) });

/** Every handler a key can reach, as clientMayRead allows them. */
const routes = (auth?: string) => [
  ["assets", () => listAssets(req("/api/assets", auth))],
  ["asset", () => getAsset(req(`/api/assets/${mine}`, auth), idParams(mine))],
  ["carbon", () => getCarbon(req(`/api/assets/${mine}/carbon?year=2025`, auth), idParams(mine))],
  ["assessment", () => getAssessment(req(`/api/assets/${mine}/assessment?year=2025`, auth), idParams(mine))],
  ["portfolio", () => getPortfolio(req("/api/portfolio?year=2025", auth))],
  ["portfolio-energy", () => getExport(req("/api/exports/portfolio-energy?year=2025", auth), kindParams("portfolio-energy"))],
  ["portfolio-carbon", () => getExport(req("/api/exports/portfolio-carbon?year=2025", auth), kindParams("portfolio-carbon"))],
  ["asset-carbon", () => getExport(req(`/api/exports/asset-carbon?year=2025&asset=${mine}`, auth), kindParams("asset-carbon"))],
] as const;

describe("client API keys on the readable routes", () => {
  it("answers every route for a valid key", async () => {
    for (const [name, call] of routes(bearer())) expect((await call()).status, name).toBe(200);
  });

  it("refuses an unknown or revoked key on every route, never falling back to full access", async () => {
    for (const [name, call] of routes(bearer("nzc_" + "z".repeat(43)))) expect((await call()).status, name).toBe(401);
    const keys = new ApiKeysRepository(db);
    keys.revokeKey(keys.listKeys()[0].id);
    for (const [name, call] of routes(bearer())) expect((await call()).status, name).toBe(401);
  });

  it("lists only the client's assets, without internal notes", async () => {
    const body = await (await listAssets(req("/api/assets", bearer()))).json();
    expect(body.assets.map((a: { id: string }) => a.id)).toEqual([mine]);
    expect(body.assets[0].notes).toBeUndefined();

    const portal = await (await listAssets(req("/api/assets"))).json();
    expect(portal.assets.map((a: { id: string }) => a.id).sort()).toEqual([mine, theirs, unassigned].sort());
    expect(portal.assets.find((a: { id: string }) => a.id === mine).notes).toBe("internal: fee dispute");
  });

  it("answers 404 for another client's asset or an unassigned one", async () => {
    for (const id of [theirs, unassigned]) {
      expect((await getAsset(req(`/api/assets/${id}`, bearer()), idParams(id))).status).toBe(404);
      expect((await getCarbon(req(`/api/assets/${id}/carbon?year=2025`, bearer()), idParams(id))).status).toBe(404);
      expect((await getAssessment(req(`/api/assets/${id}/assessment?year=2025`, bearer()), idParams(id))).status).toBe(404);
      expect((await getExport(req(`/api/exports/asset-carbon?year=2025&asset=${id}`, bearer()), kindParams("asset-carbon"))).status).toBe(404);
    }
  });

  it("rolls the portfolio up over the client's assets and leaves out organisation-wide figures", async () => {
    const body = await (await getPortfolio(req("/api/portfolio?year=2025", bearer()))).json();
    expect(body.assets.map((a: { assetId: string }) => a.assetId)).toEqual([mine]);
    expect(body.transport).toBeUndefined();
    expect(body.siteEmissions).toBeUndefined();
  });

  it("exports only the client's rows", async () => {
    for (const kind of ["portfolio-energy", "portfolio-carbon"]) {
      const csv = await (await getExport(req(`/api/exports/${kind}?year=2025&bom=false`, bearer()), kindParams(kind))).text();
      const lines = csv.trim().split("\r\n");
      expect(lines, kind).toHaveLength(2);
      expect(lines[1], kind).toContain(mine);
    }
  });

  it("refuses company-wide exports to a key even if the proxy let one through", async () => {
    for (const kind of ["secr-summary", "value-chain", "consents"]) {
      expect((await getExport(req(`/api/exports/${kind}?year=2025`, bearer()), kindParams(kind))).status, kind).toBe(403);
    }
  });
});
