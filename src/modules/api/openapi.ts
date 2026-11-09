import { NUTRITION_API_PATHS, nutritionPaths, nutritionSchemas } from "./openapi-nutrition";
import { API_SCOPES } from "./scopes";

/**
 * The OpenAPI 3.1 description of REST API v1 (DECISIONS.md ADR-090). It is
 * written by hand next to the code it describes (src/modules/api/v1.ts) and
 * checked by a test that every path in it is served.
 */

const str = { type: "string" } as const;
const nstr = { type: ["string", "null"] } as const;
const dec = {
  type: "string",
  description: "Decimal number as a string",
  example: "12.5000",
} as const;
const ndec = { ...dec, type: ["string", "null"] } as const;
const id = { type: "string", format: "uuid" } as const;
const nid = { type: ["string", "null"], format: "uuid" } as const;
const date = { type: ["string", "null"], format: "date" } as const;
const bool = { type: "boolean" } as const;

const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  required: Object.keys(properties),
  properties,
});

const schemas = {
  Error: {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: str,
          message: str,
          rule: { ...str, description: "Which business rule, for BUSINESS_RULE_VIOLATION" },
        },
      },
    },
  },
  Company: obj({
    id,
    code: str,
    name: str,
    legalName: str,
    country: nstr,
    currency: str,
    vatRegistered: bool,
    vatNumber: nstr,
    isDefault: bool,
    archived: bool,
  }),
  Branch: obj({
    id,
    code: str,
    name: str,
    type: str,
    companyId: nid,
    brandId: nid,
    timeZone: nstr,
    archived: bool,
  }),
  Warehouse: obj({ id, code: str, name: str, type: str, branchId: id, archived: bool }),
  Product: obj({
    id,
    sku: str,
    name: str,
    nameAr: nstr,
    type: str,
    baseUnit: str,
    categoryId: nid,
    barcodes: { type: "array", items: str },
    archived: bool,
  }),
  Supplier: obj({
    id,
    code: str,
    name: str,
    nameAr: nstr,
    vatNumber: nstr,
    currency: nstr,
    paymentTermsDays: { type: ["integer", "null"] },
    status: { type: "string", enum: ["PENDING_APPROVAL", "APPROVED", "BLOCKED"] },
    archived: bool,
  }),
  StockBalance: obj({
    id,
    warehouseId: id,
    locationId: nid,
    productId: id,
    lot: { oneOf: [{ type: "null" }, obj({ code: str, expiresOn: date })] },
    status: str,
    onHand: dec,
    reserved: dec,
  }),
  PurchaseOrder: obj({
    id,
    number: str,
    status: str,
    supplierId: id,
    warehouseId: id,
    companyId: nid,
    currency: str,
    expectedOn: date,
    total: dec,
    totalInCompanyCurrency: ndec,
    submittedAt: { type: ["string", "null"], format: "date-time" },
    approvedAt: { type: ["string", "null"], format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    lines: {
      type: "array",
      items: obj({
        lineNo: { type: "integer" },
        productId: id,
        quantity: dec,
        unit: str,
        unitPrice: dec,
        total: dec,
        receivedBaseQuantity: dec,
      }),
    },
  }),
  SupplierInvoice: obj({
    id,
    number: str,
    supplierInvoiceNo: str,
    supplierId: id,
    companyId: nid,
    status: str,
    matchStatus: str,
    invoiceDate: date,
    dueDate: date,
    currency: str,
    net: dec,
    vat: dec,
    gross: dec,
  }),
  SalesInvoice: obj({
    id,
    number: str,
    customerId: id,
    companyId: nid,
    status: str,
    invoiceDate: date,
    dueDate: date,
    currency: str,
    net: dec,
    vat: dec,
    gross: dec,
  }),
  PosOrder: obj({
    id,
    number: str,
    status: str,
    branchId: id,
    companyId: nid,
    channel: str,
    businessDate: date,
    orderedAt: { type: "string", format: "date-time" },
    net: dec,
    vat: dec,
    gross: dec,
    lines: {
      type: "array",
      items: obj({
        lineNo: { type: "integer" },
        menuItemId: nid,
        name: str,
        quantity: dec,
        net: dec,
        vat: dec,
        gross: dec,
      }),
    },
  }),
};

const pageParams = [
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  },
  { name: "after", in: "query", description: "The nextCursor of the previous page", schema: id },
];

const errors = {
  "401": {
    description: "Missing, unknown or revoked key",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "403": {
    description: "The key lacks the scope",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
  "429": {
    description: "Rate limit reached (600 requests per minute per key)",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  },
};

function list(
  schema: keyof typeof schemas,
  scope: keyof typeof API_SCOPES,
  summary: string,
  extra: unknown[] = [],
) {
  return {
    get: {
      summary,
      security: [{ apiKey: [scope] }],
      parameters: [...pageParams, ...extra],
      responses: {
        "200": {
          description: "A page of results",
          content: {
            "application/json": {
              schema: obj({
                data: { type: "array", items: { $ref: `#/components/schemas/${schema}` } },
                nextCursor: nid,
              }),
            },
          },
        },
        ...errors,
      },
    },
  };
}

export const API_PATHS = [
  "/companies",
  "/branches",
  "/warehouses",
  "/products",
  "/suppliers",
  "/stock",
  "/purchase-orders",
  "/purchase-orders/{id}",
  "/supplier-invoices",
  "/sales-invoices",
  "/pos-orders",
  ...NUTRITION_API_PATHS,
] as const;

export function openApiDocument(origin: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Food Ambassador API",
      version: "1.0.0",
      description:
        "Access to one organization's data: read-only, except the nutrition library (nutrition:write). Create a key under Settings → API keys; send it as `Authorization: Bearer fa_…`. A key may be limited to one company. Amounts are decimal strings; quantities are in the product's base unit unless a unit is given; pages are ordered by id and continued with `after`.",
    },
    servers: [{ url: `${origin}/api/v1` }],
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: `Scopes: ${Object.keys(API_SCOPES).join(", ")}`,
        },
      },
      schemas: { ...schemas, ...nutritionSchemas },
    },
    paths: {
      "/companies": list("Company", "sites:read", "Companies (legal entities)"),
      "/branches": list("Branch", "sites:read", "Branches"),
      "/warehouses": list("Warehouse", "sites:read", "Warehouses"),
      "/products": list("Product", "products:read", "Products"),
      "/suppliers": list("Supplier", "suppliers:read", "Suppliers"),
      "/stock": list("StockBalance", "stock:read", "Stock on hand", [
        { name: "warehouseId", in: "query", schema: id },
      ]),
      "/purchase-orders": list("PurchaseOrder", "purchasing:read", "Purchase orders", [
        { name: "status", in: "query", schema: str },
      ]),
      "/purchase-orders/{id}": {
        get: {
          summary: "One purchase order",
          security: [{ apiKey: ["purchasing:read"] }],
          parameters: [{ name: "id", in: "path", required: true, schema: id }],
          responses: {
            "200": {
              description: "The order",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/PurchaseOrder" } },
              },
            },
            "404": {
              description: "Not found",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            ...errors,
          },
        },
      },
      "/supplier-invoices": list("SupplierInvoice", "invoices:read", "Supplier invoices"),
      "/sales-invoices": list("SalesInvoice", "sales:read", "B2B sales invoices"),
      "/pos-orders": list("PosOrder", "sales:read", "Point-of-sale orders", [
        {
          name: "from",
          in: "query",
          description: "Business date, inclusive",
          schema: { type: "string", format: "date" },
        },
        {
          name: "to",
          in: "query",
          description: "Business date, inclusive",
          schema: { type: "string", format: "date" },
        },
      ]),
      ...nutritionPaths(errors),
    } satisfies Record<(typeof API_PATHS)[number], unknown>,
  };
}
