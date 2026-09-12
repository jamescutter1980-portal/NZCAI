import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";

/**
 * The supplier submission paths are the only part of the portal reachable
 * without the password, so the shape of that hole is worth pinning down.
 */

const CREDENTIALS = "portal:secret";
const TOKEN = "a".repeat(43); // a base64url-encoded 32-byte token

afterEach(() => {
  delete process.env.PORTAL_BASIC_AUTH;
  delete process.env.SYNC_TOKEN;
});

const get = (path: string, headers: Record<string, string> = {}) => proxy(new NextRequest(`https://portal.example.com${path}`, { headers }));

describe("proxy", () => {
  it("lets everything through when no password is configured", () => {
    expect(get("/value-chain").status).toBe(200);
  });

  it("challenges an unauthenticated request once a password is set", () => {
    process.env.PORTAL_BASIC_AUTH = CREDENTIALS;
    const res = get("/value-chain");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  it("accepts the configured password", () => {
    process.env.PORTAL_BASIC_AUTH = CREDENTIALS;
    const res = get("/value-chain", { authorization: `Basic ${Buffer.from(CREDENTIALS).toString("base64")}` });
    expect(res.status).toBe(200);
  });

  it("lets a tokenised supplier submission through, page and API alike", () => {
    process.env.PORTAL_BASIC_AUTH = CREDENTIALS;
    expect(get(`/value-chain/submit/${TOKEN}`).status).toBe(200);
    expect(get(`/api/value-chain/submit/${TOKEN}`).status).toBe(200);
    expect(get(`/api/value-chain/submit/${TOKEN}/`).status).toBe(200);
  });

  it("keeps the rest of the value chain behind the password", () => {
    process.env.PORTAL_BASIC_AUTH = CREDENTIALS;
    // No token at all, a short one, and an attempt to walk out of the submission path.
    expect(get("/value-chain/submit").status).toBe(401);
    expect(get("/value-chain/submit/short").status).toBe(401);
    expect(get(`/value-chain/submit/${TOKEN}/../../counterparties`).status).toBe(401);
    expect(get(`/api/value-chain/submissions`).status).toBe(401);
    expect(get(`/api/value-chain/report`).status).toBe(401);
    expect(get(`/api/value-chain/submit/${TOKEN}/extra`).status).toBe(401);
  });
});
