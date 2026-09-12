export type N3rgyEnvironment = "sandbox" | "live";

/**
 * Hosts for the n3rgy data platform (business API, keyed by MPxN).
 * The sandbox host is confirmed from published client code. The live host is
 * the documented default but should be checked against the Customer Service
 * API Developer's Guide on first live run; override with N3RGY_BASE_URL.
 */
export const N3RGY_HOSTS: Record<N3rgyEnvironment, string> = {
  sandbox: "https://sandboxapi.data.n3rgy.com",
  live: "https://api.data.n3rgy.com",
};

export interface N3rgyConfig {
  apiKey: string;
  environment: N3rgyEnvironment;
  baseUrl: string;
}

export class N3rgyConfigError extends Error {}

/**
 * Reads configuration from environment variables. Throws if the key is
 * missing so a misconfigured deployment fails at first use, not silently.
 */
export type EnvLike = Record<string, string | undefined>;

export function loadN3rgyConfig(env: EnvLike = process.env): N3rgyConfig {
  const apiKey = env.N3RGY_API_KEY?.trim();
  if (!apiKey) {
    throw new N3rgyConfigError(
      "N3RGY_API_KEY is not set. Copy .env.example to .env.local and add the key from data.n3rgy.com.",
    );
  }
  const environment = (env.N3RGY_ENV?.trim() || "sandbox") as N3rgyEnvironment;
  if (environment !== "sandbox" && environment !== "live") {
    throw new N3rgyConfigError(`N3RGY_ENV must be "sandbox" or "live", got "${environment}".`);
  }
  const baseUrl = (env.N3RGY_BASE_URL?.trim() || N3RGY_HOSTS[environment]).replace(/\/+$/, "");
  return { apiKey, environment, baseUrl };
}

/** Reports configuration state without ever exposing the key. */
export function describeN3rgyConfig(env: EnvLike = process.env) {
  try {
    const cfg = loadN3rgyConfig(env);
    return { configured: true as const, environment: cfg.environment, baseUrl: cfg.baseUrl };
  } catch (e) {
    return { configured: false as const, reason: (e as Error).message };
  }
}
