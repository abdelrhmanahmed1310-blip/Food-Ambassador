import "server-only";
import { getEnv } from "@/server/env";
import { consumeRateLimit } from "@/server/rate-limit";

/**
 * Food composition providers (DECISIONS.md ADR-132). A provider returns the
 * source's own payloads; normalization happens elsewhere. USDA FoodData
 * Central is the first; others (e.g. national tables) plug in through the
 * same interface.
 */

export type ProviderErrorCode =
  "NOT_CONFIGURED" | "RATE_LIMITED" | "UNAVAILABLE" | "BAD_RESPONSE" | "NOT_FOUND";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

export interface SearchQuery {
  query: string;
  pageNumber: number;
  pageSize: number;
  dataTypes?: string[];
}

export interface FoodProvider {
  readonly id: "USDA_FDC";
  configured(): boolean;
  search(q: SearchQuery): Promise<{ total: number; foods: unknown[] }>;
  food(id: string): Promise<unknown>;
  /** Up to 20 ids per call; missing ids are simply absent. */
  foods(ids: readonly string[]): Promise<unknown[]>;
  /** The newest publication date in a data type, for release detection. */
  latestPublished(dataType: string): Promise<string | null>;
  ping(): Promise<{ ok: boolean; ms: number; error?: string }>;
}

/** The USDA data types (FDC names). */
export const USDA_DATA_TYPES = [
  "Foundation",
  "SR Legacy",
  "Survey (FNDDS)",
  "Branded",
  "Experimental",
] as const;

type Fetch = typeof fetch;
let testFetch: Fetch | null = null;
let testSleep: ((ms: number) => Promise<void>) | null = null;
/** Tests replace the network and the clock; nothing else should. */
export function setTestUsdaTransport(
  f: Fetch | null,
  sleep?: ((ms: number) => Promise<void>) | null,
) {
  testFetch = f;
  testSleep = sleep ?? null;
}

const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

export class UsdaFdcProvider implements FoodProvider {
  readonly id = "USDA_FDC" as const;

  configured() {
    return Boolean(getEnv().USDA_FDC_API_KEY);
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const env = getEnv();
    if (!env.USDA_FDC_API_KEY)
      throw new ProviderError("NOT_CONFIGURED", "USDA FoodData Central is not configured");
    // One budget for every instance, below USDA's hourly limit per key.
    const limit = await consumeRateLimit("usda-fdc", {
      window: 3600,
      max: env.USDA_FDC_REQUESTS_PER_HOUR,
    });
    if (!limit.allowed)
      throw new ProviderError("RATE_LIMITED", "USDA hourly request budget used", limit.retryAfter);
    const doFetch = testFetch ?? fetch;
    const sleep = testSleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last: ProviderError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${env.USDA_FDC_BASE_URL}${path}`, {
          method,
          // The key travels in a header, never in a URL that could be logged.
          headers: {
            "X-Api-Key": env.USDA_FDC_API_KEY,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        last = new ProviderError(
          "UNAVAILABLE",
          (error as Error).name === "TimeoutError"
            ? "USDA did not answer in time"
            : "USDA could not be reached",
        );
        if (attempt < MAX_ATTEMPTS) await sleep(backoff(attempt));
        continue;
      }
      if (res.ok) {
        try {
          return await res.json();
        } catch {
          throw new ProviderError("BAD_RESPONSE", "USDA returned something that is not JSON");
        }
      }
      if (res.status === 404)
        throw new ProviderError("NOT_FOUND", "Not found in USDA FoodData Central");
      if (res.status === 401 || res.status === 403)
        throw new ProviderError("NOT_CONFIGURED", "USDA refused the API key");
      if (res.status === 429 || res.status >= 500) {
        const after = retryAfterSeconds(res.headers.get("retry-after"));
        last = new ProviderError(
          res.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE",
          res.status === 429 ? "USDA rate limit reached" : `USDA error ${res.status}`,
          after,
        );
        if (attempt < MAX_ATTEMPTS)
          await sleep(Math.min(after !== null ? after * 1000 : backoff(attempt), MAX_DELAY_MS));
        continue;
      }
      throw new ProviderError("BAD_RESPONSE", `USDA answered ${res.status}`);
    }
    console.error(`usda-fdc ${method} ${path.split("?")[0]}: ${last?.message}`);
    throw last ?? new ProviderError("UNAVAILABLE", "USDA could not be reached");
  }

  async search(q: SearchQuery) {
    const data = (await this.call("POST", "/foods/search", {
      query: q.query,
      pageNumber: q.pageNumber,
      pageSize: q.pageSize,
      ...(q.dataTypes?.length ? { dataType: q.dataTypes } : {}),
    })) as { totalHits?: unknown; foods?: unknown };
    if (!Array.isArray(data?.foods))
      throw new ProviderError("BAD_RESPONSE", "USDA search answer has no foods");
    return {
      total: typeof data.totalHits === "number" ? data.totalHits : data.foods.length,
      foods: data.foods,
    };
  }

  async food(id: string) {
    if (!/^\d{1,10}$/.test(id)) throw new ProviderError("NOT_FOUND", "Not an FDC id");
    return this.call("GET", `/food/${id}?format=full`);
  }

  async foods(ids: readonly string[]) {
    const valid = ids.filter((i) => /^\d{1,10}$/.test(i)).slice(0, 20);
    if (valid.length === 0) return [];
    const data = await this.call("POST", "/foods", { fdcIds: valid.map(Number), format: "full" });
    if (!Array.isArray(data))
      throw new ProviderError("BAD_RESPONSE", "USDA batch answer is not a list");
    return data;
  }

  async latestPublished(dataType: string) {
    const data = await this.call("POST", "/foods/list", {
      dataType: [dataType],
      pageSize: 1,
      pageNumber: 1,
      sortBy: "publishedDate",
      sortOrder: "desc",
    });
    const first = Array.isArray(data)
      ? (data[0] as Record<string, unknown> | undefined)
      : undefined;
    const v = first?.publicationDate ?? first?.publishedDate;
    return typeof v === "string" ? v : null;
  }

  async ping() {
    const t = Date.now();
    try {
      await this.call("POST", "/foods/list", { pageSize: 1, pageNumber: 1 });
      return { ok: true, ms: Date.now() - t };
    } catch (error) {
      return {
        ok: false,
        ms: Date.now() - t,
        error: (error as ProviderError).code ?? "UNAVAILABLE",
      };
    }
  }
}

/** 500 ms, 1 s, 2 s… with up to 25 % jitter. */
export function backoff(attempt: number) {
  const base = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  return Math.round(base * (1 + Math.random() * 0.25));
}

export function retryAfterSeconds(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 3600);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, Math.min(Math.round((t - Date.now()) / 1000), 3600));
}

let provider: FoodProvider = new UsdaFdcProvider();
export const usdaProvider = () => provider;
/** Tests may swap the whole provider. */
export function setTestProvider(p: FoodProvider | null) {
  provider = p ?? new UsdaFdcProvider();
}
