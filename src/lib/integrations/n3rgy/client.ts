import { chunkRange, toN3rgyDateString, type DateRange } from "./dates";
import { loadN3rgyConfig, type N3rgyConfig } from "./config";
import {
  rawConsumptionSchema,
  rawFindMpxnSchema,
  rawListingSchema,
  rawTariffSchema,
  type Granularity,
  type RawConsumption,
  type RawFindMpxn,
  type RawListing,
  type RawTariff,
  type Utility,
} from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface N3rgyClientOptions {
  config?: N3rgyConfig;
  fetch?: FetchLike;
  /** Maximum calendar days per request. The API limit is 90. */
  maxDaysPerRequest?: number;
  /** Retries on 429 and 5xx responses. */
  maxRetries?: number;
  /** Base back-off in milliseconds. */
  retryDelayMs?: number;
  /** Clock and sleep are injectable for tests. */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export class N3rgyApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(message);
    this.name = "N3rgyApiError";
  }
}

export interface ConsumptionQuery {
  mpxn: string;
  utility: Utility;
  start: Date;
  end: Date;
  granularity?: Granularity;
}

export interface ChunkedResult<T> {
  /** One raw response per chunk, in chronological order. */
  chunks: T[];
  /** True if any chunk came back 206 Partial Content. */
  partial: boolean;
  retrievedAt: string;
}

const MPXN_PATTERN = /^\d{6,13}$/;

/**
 * Client for the n3rgy data platform. Requests are keyed by MPxN and
 * authenticated with the platform API key. Both header spellings are sent
 * because the platform's v1 endpoints read `Authorization` and the v2
 * endpoints read `X-API-KEY`.
 */
export class N3rgyClient {
  private readonly config: N3rgyConfig;
  private readonly fetchImpl: FetchLike;
  private readonly maxDays: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: N3rgyClientOptions = {}) {
    this.config = opts.config ?? loadN3rgyConfig();
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.maxDays = Math.min(opts.maxDaysPerRequest ?? 90, 90);
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get environment() {
    return this.config.environment;
  }

  /** Checks whether an MPxN is known to the platform. */
  async findMpxn(mpxn: string): Promise<RawFindMpxn> {
    return this.getJson(`/find-mpxn/${assertMpxn(mpxn)}`, {}, rawFindMpxnSchema);
  }

  /** Utilities (electricity, gas) available for a consented MPxN. */
  async listUtilities(mpxn: string): Promise<RawListing> {
    return this.getJson(`/${assertMpxn(mpxn)}`, {}, rawListingSchema);
  }

  /** Reading types (consumption, tariff, production) available for a utility. */
  async listReadingTypes(mpxn: string, utility: Utility): Promise<RawListing> {
    return this.getJson(`/${assertMpxn(mpxn)}/${utility}`, {}, rawListingSchema);
  }

  async getConsumption(q: ConsumptionQuery): Promise<ChunkedResult<RawConsumption>> {
    return this.getChunked(`/${assertMpxn(q.mpxn)}/${q.utility}/consumption/1`, q, rawConsumptionSchema, {
      granularity: q.granularity ?? "halfhour",
    });
  }

  /** Export (production) readings, only present where an export register exists. */
  async getProduction(q: ConsumptionQuery): Promise<ChunkedResult<RawConsumption>> {
    return this.getChunked(`/${assertMpxn(q.mpxn)}/${q.utility}/production/1`, q, rawConsumptionSchema, {
      granularity: q.granularity ?? "halfhour",
    });
  }

  async getTariff(q: Omit<ConsumptionQuery, "granularity">): Promise<ChunkedResult<RawTariff>> {
    return this.getChunked(`/${assertMpxn(q.mpxn)}/${q.utility}/tariff/1`, q, rawTariffSchema, {});
  }

  private async getChunked<T>(
    path: string,
    range: DateRange,
    schema: { parse: (v: unknown) => T },
    extraParams: Record<string, string>,
  ): Promise<ChunkedResult<T>> {
    const chunks: T[] = [];
    let partial = false;
    for (const chunk of chunkRange(range, this.maxDays)) {
      const { data, status } = await this.getJsonWithStatus(
        path,
        { start: toN3rgyDateString(chunk.start), end: toN3rgyDateString(chunk.end), ...extraParams },
        schema,
      );
      if (status === 206) partial = true;
      chunks.push(data);
    }
    return { chunks, partial, retrievedAt: this.now().toISOString() };
  }

  private async getJson<T>(
    path: string,
    params: Record<string, string>,
    schema: { parse: (v: unknown) => T },
  ): Promise<T> {
    return (await this.getJsonWithStatus(path, params, schema)).data;
  }

  private async getJsonWithStatus<T>(
    path: string,
    params: Record<string, string>,
    schema: { parse: (v: unknown) => T },
  ): Promise<{ data: T; status: number }> {
    const url = new URL(this.config.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("output", "json");

    let attempt = 0;
    for (;;) {
      const res = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: this.config.apiKey,
          "x-api-key": this.config.apiKey,
        },
      });
      if (res.ok) {
        const text = await res.text();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new N3rgyApiError("Response was not JSON", res.status, url.toString(), text.slice(0, 500));
        }
        return { data: schema.parse(json), status: res.status };
      }
      const body = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleep(this.retryDelayMs * 2 ** (attempt - 1));
        continue;
      }
      throw new N3rgyApiError(
        describeStatus(res.status),
        res.status,
        url.toString(),
        body.slice(0, 500),
      );
    }
  }
}

function assertMpxn(mpxn: string): string {
  const trimmed = mpxn.replace(/\s+/g, "");
  if (!MPXN_PATTERN.test(trimmed)) {
    throw new RangeError(`"${mpxn}" is not a valid MPAN or MPRN (6 to 13 digits).`);
  }
  return trimmed;
}

function describeStatus(status: number): string {
  switch (status) {
    case 401:
      return "n3rgy rejected the API key (401). Check N3RGY_API_KEY and that the key is enabled for this environment.";
    case 403:
      return "n3rgy refused access (403). The MPxN has no active consent for this key, or the key is not enabled for live data.";
    case 404:
      return "n3rgy has no data for this MPxN and range (404).";
    case 429:
      return "n3rgy rate limit reached (429).";
    default:
      return `n3rgy request failed with HTTP ${status}.`;
  }
}
