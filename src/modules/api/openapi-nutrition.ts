/**
 * OpenAPI description of the nutrition endpoints of REST API v1 (DECISIONS.md
 * ADR-132), merged into openApiDocument. Written by hand next to the services
 * in src/modules/nutrition/engine; the API test checks every path is served.
 */

const str = { type: "string" } as const;
const nstr = { type: ["string", "null"] } as const;
const id = { type: "string", format: "uuid" } as const;
const nid = { type: ["string", "null"], format: "uuid" } as const;
const int = { type: "integer" } as const;
const bool = { type: "boolean" } as const;
const ts = { type: "string", format: "date-time" } as const;
const nts = { type: ["string", "null"], format: "date-time" } as const;
const dec = {
  type: "string",
  description: "Decimal number as a string",
  example: "12.5",
} as const;
const ndec = {
  type: ["string", "null"],
  description: "Decimal number as a string; null when the value is not known — never 0 for unknown",
} as const;
const decIn = { oneOf: [dec, { type: "number" }] } as const;
const units = ["g", "kg", "mg", "oz", "lb", "ml", "l", "portion"] as const;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const props = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  ...(required.length ? { required } : {}),
  properties,
});
const arr = (items: unknown) => ({ type: "array", items });

const quantityItem = props(
  {
    foodId: id,
    quantity: decIn,
    unit: { type: "string", enum: units, default: "g" },
    portionId: { ...id, description: "Required when unit is portion" },
  },
  ["foodId", "quantity"],
);

const total = props({
  code: str,
  amount: { ...ndec, description: "Null unless every ingredient reports the nutrient" },
  knownAmount: dec,
  unit: str,
  complete: bool,
  missingIn: arr(id),
  belowDetectionIn: arr(id),
});

export const nutritionSchemas = {
  ValidationError: props({
    error: props({
      code: { type: "string", enum: ["VALIDATION_FAILED"] },
      message: str,
      details: props({ issues: arr(props({ path: str, message: str })) }),
    }),
  }),
  NutrientValue: props({
    code: str,
    name: str,
    nameAr: nstr,
    unit: str,
    group: str,
    status: {
      type: "string",
      enum: ["REPORTED", "CALCULATED", "BELOW_DETECTION", "NOT_APPLICABLE", "MISSING"],
    },
    amount: ndec,
    originalAmount: ndec,
    originalUnit: nstr,
    derivationCode: nstr,
    derivationDescription: nstr,
    dataPoints: { type: ["integer", "null"] },
  }),
  FoodHit: props({
    origin: { const: "LOCAL" },
    id,
    source: str,
    sourceId: str,
    dataType: nstr,
    name: str,
    nameAr: nstr,
    brand: nstr,
    barcode: nstr,
    category: nstr,
    categoryAr: nstr,
    energyKcal: ndec,
    verified: bool,
    stale: bool,
  }),
  UsdaFoodHit: props({
    origin: { const: "USDA" },
    fdcId: str,
    dataType: nstr,
    name: str,
    brand: nstr,
    barcode: nstr,
    category: nstr,
    publicationDate: nstr,
    energyKcal: ndec,
  }),
  FoodSearch: props({
    mode: { type: "string", enum: ["LOCAL", "USDA", "HYBRID"] },
    page: int,
    pageSize: int,
    local: props({ total: int, items: arr(ref("FoodHit")) }),
    external: props({
      status: {
        type: "string",
        enum: ["OK", "NOT_CONFIGURED", "UNAVAILABLE", "RATE_LIMITED", "SKIPPED"],
      },
      total: int,
      items: arr(ref("UsdaFoodHit")),
    }),
  }),
  Food: props({
    food: props({
      id,
      source: { type: "string", enum: ["USDA_FDC", "OPEN_FOOD_FACTS", "WIKIDATA", "MANUAL"] },
      sourceId: str,
      dataType: nstr,
      name: str,
      nameAr: nstr,
      displayName: { ...str, description: "The Arabic name with lang=ar when there is one" },
      brand: nstr,
      barcode: nstr,
      basis: { type: "string", enum: ["PER_100G", "PER_100ML"] },
      ingredientsText: { ...nstr, description: "As declared by the source; not translated" },
      publicationDate: nstr,
      category: { oneOf: [{ type: "null" }, props({ id, name: str, nameAr: nstr })] },
      lastFetchedAt: nts,
      verified: bool,
      verifiedAt: nts,
      archivedAt: nts,
      stale: bool,
    }),
    nutrients: arr(ref("NutrientValue")),
    missingCore: arr(
      props({
        code: str,
        name: str,
        nameAr: nstr,
        displayName: str,
        unit: str,
        status: { const: "MISSING" },
      }),
    ),
    portions: arr(ref("Serving")),
    identifiers: arr(props({ kind: str, value: str })),
    aliases: arr(props({ id, locale: str, name: str })),
    versions: arr(
      props({
        id,
        via: str,
        payloadHash: str,
        fetchedAt: ts,
        dataType: nstr,
        publicationDate: nts,
      }),
    ),
    issues: arr(props({ id, kind: str, status: str, detail: str })),
    linkedProduct: { oneOf: [{ type: "null" }, props({ id, sku: str, name: str })] },
  }),
  Serving: props({
    id,
    description: str,
    descriptionAr: nstr,
    gramWeight: ndec,
    millilitres: ndec,
    manual: bool,
  }),
  FoodNutrition: props({
    foodId: id,
    basis: str,
    quantity: dec,
    unit: str,
    basisQuantity: dec,
    grams: ndec,
    values: arr(ref("NutrientValue")),
  }),
  ImportResult: props({
    created: int,
    updated: int,
    unchanged: int,
    failed: arr(props({ ref: str, message: str })),
    foods: arr(props({ foodId: id, result: str })),
  }),
  Totals: arr(total),
  RecipeAnalysis: props({
    totalGrams: ndec,
    finishedGrams: ndec,
    yieldFromRawWeight: bool,
    total: ref("Totals"),
    perServing: { oneOf: [{ type: "null" }, ref("Totals")] },
    per100g: { oneOf: [{ type: "null" }, ref("Totals")] },
  }),
  Nutrient: props({
    id,
    code: str,
    name: str,
    nameAr: nstr,
    unit: str,
    group: str,
    usdaNutrientId: { type: ["integer", "null"] },
    usdaNumber: nstr,
    isCore: bool,
    custom: bool,
  }),
  SyncJob: props({
    id,
    kind: { type: "string", enum: ["IMPORT", "REFRESH", "RELEASE_CHECK", "BULK_FILE"] },
    status: { type: "string", enum: ["QUEUED", "RUNNING", "SUCCEEDED", "PARTIAL", "FAILED"] },
    total: int,
    processed: int,
    created: int,
    updated: int,
    unchanged: int,
    failed: int,
    createdAt: ts,
    startedAt: nts,
    finishedAt: nts,
  }),
} as const;

type Scope = "nutrition:read" | "nutrition:write";
interface Op {
  summary: string;
  scope: Scope;
  params?: unknown[];
  body?: unknown;
  ok: unknown;
  status?: string;
  extra?: Record<string, unknown>;
}

const json = (schema: unknown) => ({ "application/json": { schema } });
const err = (description: string, schema = ref("Error")) => ({
  description,
  content: json(schema),
});
const idParam = { name: "id", in: "path", required: true, schema: id };

function op(o: Op, errors: Record<string, unknown>) {
  return {
    summary: o.summary,
    security: [{ apiKey: [o.scope] }],
    ...(o.params ? { parameters: o.params } : {}),
    ...(o.body ? { requestBody: { required: true, content: json(o.body) } } : {}),
    responses: {
      [o.status ?? "200"]: { description: "OK", content: json(o.ok) },
      ...(o.body || o.params
        ? {
            "422": err(
              "Invalid input or a business rule (code says which)",
              ref("ValidationError"),
            ),
          }
        : {}),
      ...(o.params?.includes(idParam) ? { "404": err("Not found") } : {}),
      ...(o.body
        ? {
            "400": err("The body is not valid JSON"),
            "413": err("The body is larger than 1 MB"),
            "415": err("The body is not application/json"),
          }
        : {}),
      ...o.extra,
      ...errors,
    },
  };
}

export const NUTRITION_API_PATHS = [
  "/nutrition/foods/search",
  "/nutrition/foods",
  "/nutrition/foods/{id}",
  "/nutrition/foods/{id}/nutrition",
  "/nutrition/foods/{id}/servings",
  "/nutrition/foods/{id}/refresh",
  "/nutrition/foods/calculate",
  "/nutrition/foods/compare",
  "/nutrition/foods/barcode/{code}",
  "/nutrition/nutrients",
  "/nutrition/categories",
  "/nutrition/sources",
  "/nutrition/recipes/analyze",
  "/nutrition/sync/status",
  "/nutrition/sync/jobs",
  "/nutrition/sync/usda",
  "/nutrition/health",
] as const;

const q = (name: string, schema: unknown, description?: string) => ({
  name,
  in: "query",
  schema,
  ...(description ? { description } : {}),
});

export function nutritionPaths(errors: Record<string, unknown>) {
  const usdaDown = {
    "503": err("USDA FoodData Central is not configured or not reachable"),
  };
  return {
    "/nutrition/foods/search": {
      get: op(
        {
          summary:
            "Search foods: the library (LOCAL), USDA FoodData Central (USDA) or both (HYBRID, default). USDA being down never fails a HYBRID search; external.status says what happened.",
          scope: "nutrition:read",
          params: [
            q("q", str, "Name (English or Arabic), brand, alias, FDC id or barcode"),
            q("mode", { type: "string", enum: ["LOCAL", "USDA", "HYBRID"], default: "HYBRID" }),
            q("source", {
              type: "string",
              enum: ["USDA_FDC", "OPEN_FOOD_FACTS", "WIKIDATA", "MANUAL"],
            }),
            q("dataType", str, "Foundation, SR Legacy, Survey (FNDDS), Branded, Experimental"),
            q("categoryId", id),
            q("verified", { type: "string", enum: ["true", "false"] }),
            q("sort", {
              type: "string",
              enum: ["relevance", "name", "updated", "energy"],
              default: "relevance",
            }),
            q("page", { type: "integer", minimum: 1, default: 1 }),
            q("pageSize", { type: "integer", minimum: 1, maximum: 100, default: 25 }),
          ],
          ok: ref("FoodSearch"),
        },
        errors,
      ),
    },
    "/nutrition/foods": {
      post: op(
        {
          summary:
            'Import USDA foods by FDC id (`{ fdcIds }`, up to 100; each stored in its own transaction) import one Open Food Facts product (`{ offBarcode }`), or create a manual food (values per 100 g/ml by nutrient code, or "NA" for not applicable).',
          scope: "nutrition:write",
          body: {
            oneOf: [
              props({ fdcIds: arr({ oneOf: [str, int] }) }, ["fdcIds"]),
              props(
                {
                  offBarcode: {
                    ...str,
                    description:
                      "Import this barcode from Open Food Facts (crowd-sourced; unverified)",
                  },
                },
                ["offBarcode"],
              ),
              props(
                {
                  name: str,
                  nameAr: str,
                  brand: str,
                  barcode: str,
                  categoryId: id,
                  basis: { type: "string", enum: ["PER_100G", "PER_100ML"] },
                  ingredientsText: str,
                  reference: str,
                  values: {
                    type: "object",
                    additionalProperties: { oneOf: [decIn, { const: "NA" }] },
                  },
                },
                ["name"],
              ),
            ],
          },
          ok: { oneOf: [ref("ImportResult"), ref("Food")] },
          extra: usdaDown,
        },
        errors,
      ),
    },
    "/nutrition/foods/{id}": {
      get: op(
        {
          summary:
            "One library food: every nutrient with its status (missing core nutrients listed as MISSING), servings, identifiers, aliases, source versions and open findings.",
          scope: "nutrition:read",
          params: [idParam, q("lang", { type: "string", enum: ["en", "ar"] })],
          ok: ref("Food"),
        },
        errors,
      ),
      patch: op(
        {
          summary:
            "Maintain a food: Arabic name, category, aliases, verified, archived (with a reason), nutrients marked not applicable. Source values are never edited.",
          scope: "nutrition:write",
          params: [idParam],
          body: props({
            nameAr: nstr,
            categoryId: nid,
            addAliases: arr(props({ locale: { type: "string", enum: ["en", "ar"] }, name: str })),
            removeAliasIds: arr(id),
            verified: bool,
            archived: bool,
            archiveReason: str,
            notApplicable: { type: "object", additionalProperties: bool },
          }),
          ok: props({ id }),
        },
        errors,
      ),
    },
    "/nutrition/foods/{id}/nutrition": {
      get: op(
        {
          summary:
            "Nutrition of an amount (default 100 g or 100 ml). Millilitres are converted to grams only with a density from the food's own servings.",
          scope: "nutrition:read",
          params: [
            idParam,
            q("quantity", dec),
            q("unit", { type: "string", enum: units }),
            q("portionId", id),
          ],
          ok: ref("FoodNutrition"),
        },
        errors,
      ),
    },
    "/nutrition/foods/{id}/servings": {
      get: op(
        {
          summary: "Servings (household measures) of a food",
          scope: "nutrition:read",
          params: [idParam],
          ok: arr(ref("Serving")),
        },
        errors,
      ),
      post: op(
        {
          summary: "Add a manual serving (gram weight and/or millilitres)",
          scope: "nutrition:write",
          params: [idParam],
          body: props(
            { description: str, descriptionAr: str, gramWeight: decIn, millilitres: decIn },
            ["description"],
          ),
          ok: props({ id }),
          status: "201",
        },
        errors,
      ),
    },
    "/nutrition/foods/{id}/refresh": {
      post: op(
        {
          summary:
            "Fetch a USDA record again now. A changed record gets a new source version; a verified record goes back to awaiting verification.",
          scope: "nutrition:write",
          params: [idParam],
          ok: props({
            foodId: id,
            result: { type: "string", enum: ["created", "updated", "unchanged"] },
          }),
          extra: usdaDown,
        },
        errors,
      ),
    },
    "/nutrition/foods/calculate": {
      post: op(
        {
          summary: "Several foods at their quantities, each and in total",
          scope: "nutrition:read",
          body: props({ items: arr(quantityItem) }, ["items"]),
          ok: props({
            items: arr(
              props({ foodId: id, name: str, grams: ndec, values: arr(ref("NutrientValue")) }),
            ),
            total: ref("Totals"),
          }),
        },
        errors,
      ),
    },
    "/nutrition/foods/compare": {
      post: op(
        {
          summary: "Two to ten foods side by side for the same quantity",
          scope: "nutrition:read",
          body: props(
            { foodIds: arr(id), quantity: decIn, unit: { type: "string", enum: units } },
            ["foodIds"],
          ),
          ok: props({
            foods: arr(props({ foodId: id, basis: str, quantity: dec, unit: str })),
            rows: arr(
              props({
                code: str,
                unit: nstr,
                values: arr(props({ amount: ndec, status: str })),
              }),
            ),
          }),
        },
        errors,
      ),
    },
    "/nutrition/foods/barcode/{code}": {
      get: op(
        {
          summary:
            "Find a food by GTIN/UPC barcode (leading zeros ignored): the library first, else USDA Branded Foods and Open Food Facts. Outside sources being down never fails the lookup.",
          scope: "nutrition:read",
          params: [{ name: "code", in: "path", required: true, schema: str }],
          ok: props({
            barcode: str,
            local: arr(props({ id, name: str, brand: nstr, source: str })),
            external: props({ status: str, items: arr(ref("UsdaFoodHit")) }),
            openFoodFacts: props({
              status: {
                type: "string",
                enum: [
                  "OK",
                  "NOT_FOUND",
                  "NOT_CONFIGURED",
                  "UNAVAILABLE",
                  "RATE_LIMITED",
                  "SKIPPED",
                ],
              },
              product: {
                oneOf: [
                  { type: "null" },
                  props({
                    barcode: str,
                    name: str,
                    nameAr: nstr,
                    brand: nstr,
                    basis: nstr,
                    values: { type: "object", additionalProperties: dec },
                    allergens: arr(str),
                    traces: arr(str),
                    notes: arr(str),
                    sourceUrl: str,
                    licence: str,
                  }),
                ],
              },
            }),
          }),
        },
        errors,
      ),
    },
    "/nutrition/nutrients": {
      get: op(
        {
          summary: "The nutrient dictionary (shared and the organization's own)",
          scope: "nutrition:read",
          params: [q("group", str), q("q", str)],
          ok: arr(ref("Nutrient")),
        },
        errors,
      ),
    },
    "/nutrition/categories": {
      get: op(
        {
          summary: "Food categories",
          scope: "nutrition:read",
          ok: arr(props({ id, name: str, nameAr: nstr, foods: int })),
        },
        errors,
      ),
    },
    "/nutrition/sources": {
      get: op(
        {
          summary:
            "Data sources: library records and product nutrition profiles per source, with the priority used when they disagree",
          scope: "nutrition:read",
          ok: props({
            priority: arr(props({ key: str, origin: str, label: str })),
            library: arr(props({ source: str, dataType: nstr, records: int, verified: int })),
            productProfiles: arr(props({ source: str, profiles: int, verified: int })),
          }),
        },
        errors,
      ),
    },
    "/nutrition/recipes/analyze": {
      post: op(
        {
          summary:
            "A recipe given as library foods and quantities: totals, per serving and per 100 g finished (finishedGrams adjusts for cooking loss; otherwise the raw weight is used and yieldFromRawWeight is true)",
          scope: "nutrition:read",
          body: props({ ingredients: arr(quantityItem), servings: int, finishedGrams: decIn }, [
            "ingredients",
          ]),
          ok: ref("RecipeAnalysis"),
        },
        errors,
      ),
    },
    "/nutrition/sync/status": {
      get: op(
        {
          summary: "USDA configuration, settings, the last job and counts",
          scope: "nutrition:read",
          ok: props({
            usdaConfigured: bool,
            settings: props({ autoRefresh: bool, refreshDays: int }),
            lastJob: { oneOf: [{ type: "null" }, ref("SyncJob")] },
            lastSuccessAt: nts,
            running: int,
            failedJobs: int,
          }),
        },
        errors,
      ),
    },
    "/nutrition/sync/jobs": {
      get: op(
        {
          summary: "Sync jobs, newest first",
          scope: "nutrition:read",
          params: [
            q("status", {
              type: "string",
              enum: ["QUEUED", "RUNNING", "SUCCEEDED", "PARTIAL", "FAILED"],
            }),
            q("page", { type: "integer", minimum: 1, default: 1 }),
            q("pageSize", { type: "integer", minimum: 1, maximum: 100, default: 25 }),
          ],
          ok: props({ total: int, page: int, pageSize: int, items: arr(ref("SyncJob")) }),
        },
        errors,
      ),
    },
    "/nutrition/sync/usda": {
      post: op(
        {
          summary:
            "Queue a USDA sync job (import by FDC ids up to 5,000, refresh stale records, or check for a new release). Organization-wide nutrition managers only.",
          scope: "nutrition:write",
          body: {
            oneOf: [
              props({ kind: { const: "IMPORT" }, fdcIds: arr({ oneOf: [str, int] }) }, [
                "kind",
                "fdcIds",
              ]),
              props({ kind: { const: "REFRESH" }, limit: int }, ["kind"]),
              props({ kind: { const: "RELEASE_CHECK" } }, ["kind"]),
            ],
          },
          ok: ref("SyncJob"),
          status: "202",
        },
        errors,
      ),
    },
    "/nutrition/health": {
      get: op(
        {
          summary:
            "The database and USDA FoodData Central (configured, reachable; checked at most once a minute)",
          scope: "nutrition:read",
          ok: props({
            status: { type: "string", enum: ["ok", "degraded", "down"] },
            mode: { type: "string", enum: ["LOCAL", "HYBRID"] },
            database: props({ ok: bool, ms: int }),
            usda: props({
              configured: bool,
              ok: { type: ["boolean", "null"] },
              ms: { type: ["integer", "null"] },
              error: str,
              checkedAt: nts,
            }),
          }),
        },
        errors,
      ),
    },
  } satisfies Record<(typeof NUTRITION_API_PATHS)[number], unknown>;
}
