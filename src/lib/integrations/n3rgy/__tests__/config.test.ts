import { describe, expect, it } from "vitest";
import { describeN3rgyConfig, loadN3rgyConfig, N3rgyConfigError } from "../config";

describe("loadN3rgyConfig", () => {
  it("defaults to the sandbox host", () => {
    expect(loadN3rgyConfig({ N3RGY_API_KEY: "k" })).toEqual({
      apiKey: "k",
      environment: "sandbox",
      baseUrl: "https://sandboxapi.data.n3rgy.com",
    });
  });
  it("uses the live host and honours an override", () => {
    expect(loadN3rgyConfig({ N3RGY_API_KEY: "k", N3RGY_ENV: "live" }).baseUrl).toBe("https://api.data.n3rgy.com");
    expect(
      loadN3rgyConfig({ N3RGY_API_KEY: "k", N3RGY_ENV: "live", N3RGY_BASE_URL: "https://example.test/" }).baseUrl,
    ).toBe("https://example.test");
  });
  it("throws without a key and rejects unknown environments", () => {
    expect(() => loadN3rgyConfig({})).toThrow(N3rgyConfigError);
    expect(() => loadN3rgyConfig({ N3RGY_API_KEY: "k", N3RGY_ENV: "prod" })).toThrow(N3rgyConfigError);
  });
  it("describes state without leaking the key", () => {
    const d = describeN3rgyConfig({ N3RGY_API_KEY: "secret" });
    expect(JSON.stringify(d)).not.toContain("secret");
    expect(d.configured).toBe(true);
  });
});
