import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, listUnits } from "@/modules/catalog/service";
import { createCompany } from "@/modules/organizations/companies";
import { createOrder } from "@/modules/procurement/orders";
import { createSupplier } from "@/modules/procurement/suppliers";
import { createBranch } from "@/modules/sites/branches";
import { createWarehouse } from "@/modules/sites/warehouses";
import type { TenantContext } from "@/modules/tenancy/context";
import { getDb } from "@/server/db/client";
import { apiRoute } from "@/server/routes/api-route";
import { addMember, createTenant, expectAppError } from "../../../test/support/factories";
import { createApiClient, listApiClients, revokeApiClient } from "./clients";
import { API_PATHS, openApiDocument } from "./openapi";
import { getPurchaseOrder, listProducts, listPurchaseOrders } from "./v1";

/** REST API v1 (ADR-090). */

let ctx: TenantContext;
let other: TenantContext;
let egy: string;
let ruhOrder: string;
let caiOrder: string;

const call = async (key: string | null, handler: Parameters<typeof apiRoute>[1], query = "") => {
  const res = await apiRoute(
    new Request(`http://localhost/api/v1/x${query}`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    }),
    handler,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  ({ ctx } = await createTenant("api", { baseCurrency: "SAR", timeZone: "Asia/Riyadh" }));
  ({ ctx: other } = await createTenant("api-other"));
  const each = (await listUnits(ctx)).find((u) => u.code === "each")!.id;
  for (const sku of ["A1", "A2", "A3"])
    await createProduct(ctx, {
      sku,
      nameEn: `Product ${sku}`,
      type: "RAW_MATERIAL",
      baseUomId: each,
    });
  egy = (await createCompany(ctx, { code: "EGY", name: "Egypt", legalName: "Egypt Foods" })).id;
  const ruh = (await createBranch(ctx, { code: "RUH", name: "Riyadh", type: "RESTAURANT" })).id;
  const cai = (
    await createBranch(ctx, { code: "CAI", name: "Cairo", type: "RESTAURANT", companyId: egy })
  ).id;
  const ruhWh = (await createWarehouse(ctx, { branchId: ruh, code: "R", name: "R", type: "MAIN" }))
    .id;
  const caiWh = (await createWarehouse(ctx, { branchId: cai, code: "C", name: "C", type: "MAIN" }))
    .id;
  const supplierId = (await createSupplier(ctx, { code: "S", name: "Supplier" })).id;
  ruhOrder = (await createOrder(ctx, { supplierId, warehouseId: ruhWh })).id;
  caiOrder = (await createOrder(ctx, { supplierId, warehouseId: caiWh })).id;
});

afterAll(async () => {
  await getDb().$disconnect();
});

describe("REST API v1 (ADR-090)", () => {
  it("issues a key once and keeps only its hash", async () => {
    const created = await createApiClient(ctx, { name: "BI", scopes: ["products:read"] });
    expect(created.key).toMatch(/^fa_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    const row = await getDb().apiClient.findUniqueOrThrow({ where: { id: created.id } });
    // The secret is everything after "fa_<12 characters>_"; it may itself contain "_".
    const secret = created.key.slice("fa_".length + 12 + 1);
    expect(secret).toHaveLength(43);
    expect(row.keyHash).not.toContain(secret);
    expect(JSON.stringify(await listApiClients(ctx))).not.toContain(created.key);
    // Only people who manage integrations handle keys.
    const buyer = (await addMember(ctx, "procurement")).ctx;
    await expectAppError(
      createApiClient(buyer, { name: "x", scopes: ["products:read"] }),
      "FORBIDDEN",
    );
    await expectAppError(
      createApiClient(ctx, { name: "x", scopes: ["admin:write"] }),
      "VALIDATION_FAILED",
    );
  });

  it("reads within the key's scopes, page by page", async () => {
    const { key } = await createApiClient(ctx, { name: "Catalog", scopes: ["products:read"] });
    const first = await call(key, listProducts, "?limit=2");
    expect(first.status).toBe(200);
    const page1 = first.body.data as Array<{ sku: string; id: string }>;
    expect(page1.map((p) => p.sku)).toEqual(["A1", "A2"]);
    const second = await call(key, listProducts, `?limit=2&after=${first.body.nextCursor}`);
    expect((second.body.data as Array<{ sku: string }>).map((p) => p.sku)).toEqual(["A3"]);
    expect(second.body.nextCursor).toBeNull();
    // Another scope's resource is refused.
    const refused = await call(key, listPurchaseOrders);
    expect(refused).toEqual({
      status: 403,
      body: {
        error: { code: "FORBIDDEN", message: "This key does not have the scope for this resource" },
      },
    });
  });

  it("refuses a missing, wrong or revoked key", async () => {
    expect((await call(null, listProducts)).status).toBe(401);
    const { id, key } = await createApiClient(ctx, { name: "Temp", scopes: ["products:read"] });
    const wrong = `${key.slice(0, -4)}AAAA`;
    expect((await call(wrong, listProducts)).status).toBe(401);
    expect((await call(key, listProducts)).status).toBe(200);
    await revokeApiClient(ctx, id);
    expect((await call(key, listProducts)).status).toBe(401);
    expect(
      (await getDb().apiClient.findUniqueOrThrow({ where: { id } })).lastUsedAt,
    ).not.toBeNull();
  });

  it("limits a key to one company's documents, and never another organization's", async () => {
    const { key } = await createApiClient(ctx, {
      name: "Egypt ERP",
      scopes: ["purchasing:read"],
      companyId: egy,
    });
    const r = await call(key, listPurchaseOrders);
    expect((r.body.data as Array<{ id: string }>).map((o) => o.id)).toEqual([caiOrder]);
    expect((await call(key, (api) => getPurchaseOrder(api, ruhOrder))).status).toBe(404);
    expect((await call(key, (api) => getPurchaseOrder(api, caiOrder))).status).toBe(200);
    // A key of another organization finds nothing of this one.
    const { key: theirs } = await createApiClient(other, {
      name: "Theirs",
      scopes: ["purchasing:read", "products:read"],
    });
    expect((await call(theirs, listPurchaseOrders)).body.data).toEqual([]);
    expect((await call(theirs, (api) => getPurchaseOrder(api, ruhOrder))).status).toBe(404);
    expect((await call(theirs, listProducts)).body.data).toEqual([]);
  });

  it("describes every path it serves", () => {
    const doc = openApiDocument("https://example.test");
    expect(Object.keys(doc.paths).sort()).toEqual([...API_PATHS].sort());
    for (const p of API_PATHS) {
      const file = `src/app/api/v1${p.replace(/\{(\w+)\}/g, "[$1]")}/route.ts`;
      expect(existsSync(file), file).toBe(true);
    }
    expect(doc.servers[0].url).toBe("https://example.test/api/v1");
  });
});
