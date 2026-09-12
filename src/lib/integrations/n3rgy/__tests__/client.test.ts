import { describe, expect, it, vi } from "vitest";
import { N3rgyApiError, N3rgyClient } from "../client";
import type { N3rgyConfig } from "../config";
import fixture from "./fixtures/consumption-electricity.json";

const config: N3rgyConfig = {
  apiKey: "test-key",
  environment: "sandbox",
  baseUrl: "https://sandboxapi.data.n3rgy.com",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("N3rgyClient", () => {
  it("builds the MPxN-keyed URL, sends both auth headers and parses the response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(fixture));
    const client = new N3rgyClient({ config, fetch: fetchMock, now: () => new Date("2026-09-09T12:00:00Z") });

    const result = await client.getConsumption({
      mpxn: "1234567890123",
      utility: "electricity",
      start: new Date("2026-09-01T00:00:00Z"),
      end: new Date("2026-09-01T23:59:00Z"),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://sandboxapi.data.n3rgy.com/1234567890123/electricity/consumption/1?start=202609010000&end=202609012359&granularity=halfhour&output=json",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("test-key");
    expect(headers["x-api-key"]).toBe("test-key");
    expect(result.chunks[0].values).toHaveLength(4);
    expect(result.partial).toBe(false);
    expect(result.retrievedAt).toBe("2026-09-09T12:00:00.000Z");
  });

  it("splits long ranges into multiple requests and flags partial content", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(fixture))
      .mockResolvedValueOnce(jsonResponse(fixture, 206))
      .mockResolvedValueOnce(jsonResponse(fixture));
    const client = new N3rgyClient({ config, fetch: fetchMock });

    const result = await client.getConsumption({
      mpxn: "1234567890123",
      utility: "gas",
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-09-01T00:00:00Z"),
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.chunks).toHaveLength(3);
    expect(result.partial).toBe(true);
  });

  it("retries on 429 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(fixture));
    const sleep = vi.fn(async () => {});
    const client = new N3rgyClient({ config, fetch: fetchMock, sleep });

    await client.getConsumption({
      mpxn: "1234567890123",
      utility: "electricity",
      start: new Date("2026-09-01T00:00:00Z"),
      end: new Date("2026-09-01T23:59:00Z"),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("surfaces 403 as a consent problem without retrying", async () => {
    const fetchMock = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const client = new N3rgyClient({ config, fetch: fetchMock });

    await expect(client.listUtilities("1234567890123")).rejects.toMatchObject({
      name: "N3rgyApiError",
      status: 403,
    });
    await expect(client.listUtilities("1234567890123")).rejects.toThrow(/consent/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed MPxNs before making a request", async () => {
    const fetchMock = vi.fn();
    const client = new N3rgyClient({ config, fetch: fetchMock });
    await expect(client.listUtilities("ABC")).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps non-JSON bodies in an N3rgyApiError", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>", { status: 200 }));
    const client = new N3rgyClient({ config, fetch: fetchMock });
    await expect(client.findMpxn("1234567890123")).rejects.toBeInstanceOf(N3rgyApiError);
  });
});
