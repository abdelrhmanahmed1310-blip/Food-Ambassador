import "server-only";
import { assertPermission } from "@/modules/access/authorize";
import type { ApiContext } from "@/modules/api/clients";
import { getDb } from "@/server/db/client";
import {
  addPortion,
  analyzeFoodRecipe,
  calculateFoods,
  compareFoods,
  createFood,
  findByBarcode,
  foodNutrition,
  getFood,
  importUsdaFoods,
  listCategories,
  listNutrients,
  listPortions,
  listSources,
  refreshFood,
  searchFoods,
  updateFood,
} from "./foods";
import { ApiHttpError } from "@/server/routes/api-route";
import { ProviderError, usdaProvider } from "./providers";
import { listSyncJobs, requestSync, syncStatus } from "./sync";

/**
 * REST API v1 nutrition endpoints (DECISIONS.md ADR-132): the same services
 * as the pages, run as the key's creator with the key's scopes. Routes under
 * src/app/api/v1/nutrition only pass the request through.
 */

const params = (q: URLSearchParams) => Object.fromEntries(q.entries());
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const apiSearchFoods = (api: ApiContext, q: URLSearchParams) =>
  searchFoods(api.ctx, params(q));

/** POST /nutrition/foods: `{ fdcIds: [...] }` imports from USDA; anything else creates a manual food. */
export async function apiCreateFoods(api: ApiContext, body: unknown) {
  if (isObject(body) && "fdcIds" in body) return upstream(importUsdaFoods(api.ctx, body.fdcIds));
  return createFood(api.ctx, body);
}

/** USDA failures as HTTP: not configured or down → 503, over the hourly budget → 429, unknown id → 404. */
async function upstream<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    if (error.code === "NOT_FOUND")
      throw new ApiHttpError(404, "NOT_FOUND", "Not found in USDA FoodData Central");
    if (error.code === "RATE_LIMITED")
      throw new ApiHttpError(429, "USDA_RATE_LIMITED", "The hourly USDA request budget is used up");
    if (error.code === "NOT_CONFIGURED")
      throw new ApiHttpError(503, "USDA_NOT_CONFIGURED", "USDA FoodData Central is not configured");
    throw new ApiHttpError(503, "USDA_UNAVAILABLE", "USDA FoodData Central is not reachable");
  }
}

export const apiGetFood = (api: ApiContext, id: string, q: URLSearchParams) =>
  getFood(api.ctx, id, { lang: q.get("lang") ?? undefined });
export const apiUpdateFood = (api: ApiContext, id: string, body: unknown) =>
  updateFood(api.ctx, id, body);
export const apiFoodNutrition = (api: ApiContext, id: string, q: URLSearchParams) =>
  foodNutrition(api.ctx, id, params(q));
export const apiListServings = (api: ApiContext, id: string) => listPortions(api.ctx, id);
export const apiAddServing = (api: ApiContext, id: string, body: unknown) =>
  addPortion(api.ctx, id, body);
export const apiRefreshFood = (api: ApiContext, id: string) => upstream(refreshFood(api.ctx, id));
export const apiCalculate = (api: ApiContext, body: unknown) => calculateFoods(api.ctx, body);
export const apiCompare = (api: ApiContext, body: unknown) => compareFoods(api.ctx, body);
export const apiAnalyzeRecipe = (api: ApiContext, body: unknown) =>
  analyzeFoodRecipe(api.ctx, body);
export const apiBarcode = (api: ApiContext, code: string) => upstream(findByBarcode(api.ctx, code));
export const apiNutrients = (api: ApiContext, q: URLSearchParams) =>
  listNutrients(api.ctx, params(q));
export const apiCategories = (api: ApiContext) => listCategories(api.ctx);
export const apiSources = (api: ApiContext) => listSources(api.ctx);
export const apiSyncStatus = (api: ApiContext) => syncStatus(api.ctx);
export const apiSyncJobs = (api: ApiContext, q: URLSearchParams) =>
  listSyncJobs(api.ctx, params(q));
export const apiRequestUsdaSync = (api: ApiContext, body: unknown) => requestSync(api.ctx, body);

let pingCache: {
  at: number;
  value: Awaited<ReturnType<ReturnType<typeof usdaProvider>["ping"]>>;
} | null = null;
const PING_TTL_MS = 60_000;

/** Test hook. */
export function clearNutritionHealthCache() {
  pingCache = null;
}

/** GET /nutrition/health: the database and USDA (configured, reachable), USDA checked once a minute. */
export async function apiNutritionHealth(api: ApiContext) {
  assertPermission(api.ctx.grants, "nutrition.view");
  const t = Date.now();
  let database: { ok: boolean; ms: number };
  try {
    await getDb().$queryRaw`SELECT 1`;
    database = { ok: true, ms: Date.now() - t };
  } catch {
    database = { ok: false, ms: Date.now() - t };
  }
  const provider = usdaProvider();
  const configured = provider.configured();
  let usda: {
    configured: boolean;
    ok: boolean | null;
    ms: number | null;
    error?: string;
    checkedAt: string | null;
  };
  if (!configured) usda = { configured, ok: null, ms: null, checkedAt: null };
  else {
    if (!pingCache || Date.now() - pingCache.at > PING_TTL_MS)
      pingCache = { at: Date.now(), value: await provider.ping() };
    usda = {
      configured,
      ...pingCache.value,
      checkedAt: new Date(pingCache.at).toISOString(),
    };
  }
  return {
    status: database.ok && (usda.ok ?? true) ? "ok" : database.ok ? "degraded" : "down",
    database,
    usda,
    mode: configured ? "HYBRID" : "LOCAL",
  };
}
